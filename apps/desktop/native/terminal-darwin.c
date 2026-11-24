#define _DARWIN_C_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

extern char **environ;

enum {
  FRAME_READY = 0x01,
  FRAME_OUTPUT = 0x02,
  FRAME_ACTIVITY = 0x03,
  FRAME_EXIT = 0x04,
  FRAME_ERROR = 0x05,
  FRAME_SHELL_EXITED = 0x06,

  FRAME_INPUT = 0x10,
  FRAME_RESIZE = 0x11,
  FRAME_SHUTDOWN = 0x13,
  FRAME_PING_ACTIVITY = 0x14,
};

#define MIN_COLS 2
#define MAX_COLS 400
#define MIN_ROWS 1
#define MAX_ROWS 160
#define MAX_FRAME_BYTES (128U * 1024U)
#define MAX_IO_QUEUE_BYTES (64U * 1024U)
#define HOST_OUT_PAUSE_BYTES (64U * 1024U)
#define HOST_OUT_RESUME_BYTES (16U * 1024U)
#define MAX_RELATED_PIDS 4096
#define MAX_PID_SCAN 65536
#define ACTIVITY_POLL_INTERVAL_MS 250

#ifndef SSTOP
#define SSTOP 4
#endif
#ifndef SZOMB
#define SZOMB 5
#endif

static volatile sig_atomic_t g_sigchld_flag = 0;
static int g_sigchld_pipe[2] = {-1, -1};

struct ByteQueue {
  uint8_t *data;
  size_t len;
  size_t cap;
};

struct SessionMember {
  pid_t pid;
  pid_t pgid;
  uint64_t start_us;
  uint32_t status;
  char command[128];
};

struct KnownMember {
  pid_t pid;
  uint64_t start_us;
};

struct KnownMemberTable {
  struct KnownMember items[MAX_RELATED_PIDS];
  size_t count;
};

static uint64_t now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000ULL);
}

static uint64_t proc_start_us(const struct proc_bsdinfo *info) {
  return (uint64_t)info->pbi_start_tvsec * 1000000ULL + (uint64_t)info->pbi_start_tvusec;
}

static void on_sigchld(int sig) {
  (void)sig;
  g_sigchld_flag = 1;
  if (g_sigchld_pipe[1] >= 0) {
    uint8_t b = 1;
    ssize_t written = write(g_sigchld_pipe[1], &b, 1);
    (void)written;
  }
}

static void drain_sigchld_pipe(void) {
  if (g_sigchld_pipe[0] < 0) return;
  uint8_t buf[64];
  while (read(g_sigchld_pipe[0], buf, sizeof(buf)) > 0) {
  }
}

static bool set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return false;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static bool set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD, 0);
  if (flags < 0) return false;
  return fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

static bool queue_append(struct ByteQueue *q, const uint8_t *bytes, size_t n) {
  if (n == 0) return true;
  if (n > SIZE_MAX - q->len) return false;
  if (q->len + n > q->cap) {
    size_t next_cap = q->cap == 0 ? 4096U : q->cap;
    while (next_cap < q->len + n) {
      if (next_cap > SIZE_MAX / 2U) return false;
      next_cap *= 2U;
    }
    uint8_t *next = realloc(q->data, next_cap);
    if (!next) return false;
    q->data = next;
    q->cap = next_cap;
  }
  memcpy(q->data + q->len, bytes, n);
  q->len += n;
  return true;
}

static void queue_consume(struct ByteQueue *q, size_t n) {
  if (n == 0) return;
  if (n >= q->len) {
    q->len = 0;
    return;
  }
  memmove(q->data, q->data + n, q->len - n);
  q->len -= n;
}

static bool enqueue_frame(struct ByteQueue *out, uint8_t type, const uint8_t *payload, uint32_t len) {
  uint8_t header[5];
  header[0] = type;
  header[1] = (uint8_t)((len >> 24) & 0xffU);
  header[2] = (uint8_t)((len >> 16) & 0xffU);
  header[3] = (uint8_t)((len >> 8) & 0xffU);
  header[4] = (uint8_t)(len & 0xffU);
  if (!queue_append(out, header, sizeof(header))) return false;
  return queue_append(out, payload, len);
}

static bool write_all_blocking(int fd, const uint8_t *data, size_t len) {
  size_t off = 0;
  uint64_t deadline = now_ms() + 1500ULL;
  while (off < len) {
    ssize_t n = write(fd, data + off, len - off);
    if (n > 0) {
      off += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (now_ms() >= deadline) return false;
      struct pollfd pfd = {.fd = fd, .events = POLLOUT};
      (void)poll(&pfd, 1, 50);
      continue;
    }
    return false;
  }
  return true;
}

static void write_frame_sync(int fd, uint8_t type, const char *json) {
  size_t len = strlen(json);
  uint8_t header[5];
  header[0] = type;
  header[1] = (uint8_t)((len >> 24) & 0xffU);
  header[2] = (uint8_t)((len >> 16) & 0xffU);
  header[3] = (uint8_t)((len >> 8) & 0xffU);
  header[4] = (uint8_t)(len & 0xffU);
  (void)write_all_blocking(fd, header, sizeof(header));
  (void)write_all_blocking(fd, (const uint8_t *)json, len);
}

static void json_escape(const char *src, char *dst, size_t dst_cap) {
  size_t out = 0;
  if (!src) {
    if (dst_cap > 0) dst[0] = '\0';
    return;
  }
  for (size_t i = 0; src[i] != '\0' && out + 7 < dst_cap; i++) {
    unsigned char ch = (unsigned char)src[i];
    if (ch == '"' || ch == '\\') {
      dst[out++] = '\\';
      dst[out++] = (char)ch;
    } else if (ch == '\n') {
      dst[out++] = '\\';
      dst[out++] = 'n';
    } else if (ch == '\r') {
      dst[out++] = '\\';
      dst[out++] = 'r';
    } else if (ch == '\t') {
      dst[out++] = '\\';
      dst[out++] = 't';
    } else if (ch < 0x20U) {
      int n = snprintf(dst + out, dst_cap - out, "\\u%04x", (unsigned)ch);
      if (n > 0) out += (size_t)n;
    } else {
      dst[out++] = (char)ch;
    }
  }
  if (dst_cap > 0) dst[out < dst_cap ? out : dst_cap - 1] = '\0';
}

static bool read_proc_bsd(pid_t pid, struct proc_bsdinfo *out) {
  memset(out, 0, sizeof(*out));
  int ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, (int)sizeof(*out));
  return ret == (int)sizeof(*out);
}

static void known_record(struct KnownMemberTable *table, pid_t pid, uint64_t start_us, bool *anomaly) {
  for (size_t i = 0; i < table->count; i++) {
    if (table->items[i].pid == pid) {
      if (table->items[i].start_us != start_us) {
        if (anomaly) *anomaly = true;
        table->items[i].start_us = start_us;
      }
      return;
    }
  }
  if (table->count < MAX_RELATED_PIDS) {
    table->items[table->count].pid = pid;
    table->items[table->count].start_us = start_us;
    table->count += 1;
  }
}

static size_t enumerate_session_members(
    pid_t shell_pid,
    pid_t shell_sid,
    uint64_t shell_start_us,
    bool include_shell_if_alive,
    struct SessionMember *out_members,
    size_t max_members,
    struct KnownMemberTable *known,
    bool *out_complete,
    bool *out_anomaly) {
  *out_complete = true;

  if (shell_sid <= 1 || shell_start_us == 0) {
    *out_complete = false;
    return 0;
  }

  int estimated = proc_listallpids(NULL, 0);
  if (estimated <= 0) {
    *out_complete = false;
    return 0;
  }

  size_t pid_cap = (size_t)estimated + 256U;
  if (pid_cap > MAX_PID_SCAN) pid_cap = MAX_PID_SCAN;
  pid_t *all_pids = NULL;
  int count_returned = 0;

  for (int attempt = 0; attempt < 4; attempt++) {
    free(all_pids);
    all_pids = calloc(pid_cap, sizeof(pid_t));
    if (!all_pids) {
      *out_complete = false;
      return 0;
    }
    count_returned = proc_listallpids(all_pids, (int)(pid_cap * sizeof(pid_t)));
    if (count_returned <= 0) {
      free(all_pids);
      *out_complete = false;
      return 0;
    }
    if ((size_t)count_returned < pid_cap) break;
    if (pid_cap >= MAX_PID_SCAN) {
      *out_complete = false;
      break;
    }
    pid_cap *= 2U;
    if (pid_cap > MAX_PID_SCAN) pid_cap = MAX_PID_SCAN;
  }

  size_t all_count = (size_t)count_returned;
  if (all_count > pid_cap) all_count = pid_cap;

  size_t out_count = 0;
  pid_t self_pid = getpid();

  for (size_t i = 0; i < all_count; i++) {
    pid_t p = all_pids[i];
    if (p <= 1 || p == self_pid) continue;

    errno = 0;
    pid_t psid = getsid(p);
    if (psid < 0) {
      // Another UID or unavailable proc metadata could still be outside our session,
      // but anything other than ESRCH / EPERM marks enumeration incomplete.
      if (errno != ESRCH && errno != EPERM) {
        *out_complete = false;
      }
      continue;
    }
    if (psid != shell_sid) continue;

    struct proc_bsdinfo info;
    if (!read_proc_bsd(p, &info)) {
      if (errno != ESRCH) *out_complete = false;
      continue;
    }
    if (info.pbi_status == SZOMB) continue;

    uint64_t p_start = proc_start_us(&info);
    if (p == shell_pid) {
      if (p_start != shell_start_us) {
        *out_anomaly = true;
        continue;
      }
      if (!include_shell_if_alive) continue;
    } else if (p_start + 10000ULL < shell_start_us) {
      *out_anomaly = true;
      continue;
    }

    known_record(known, p, p_start, out_anomaly);
    if (out_count < max_members) {
      struct SessionMember *m = &out_members[out_count++];
      m->pid = p;
      m->pgid = (pid_t)info.pbi_pgid;
      m->start_us = p_start;
      m->status = info.pbi_status;
      const char *name = info.pbi_comm[0] ? info.pbi_comm : info.pbi_name;
      snprintf(m->command, sizeof(m->command), "%s", name ? name : "");
    } else {
      *out_complete = false;
    }
  }

  free(all_pids);
  return out_count;
}

static bool signal_verified_member(
    const struct SessionMember *member,
    pid_t shell_sid,
    int sig,
    bool *out_anomaly) {
  pid_t psid = getsid(member->pid);
  if (psid != shell_sid) {
    if (psid >= 0) *out_anomaly = true;
    return false;
  }
  struct proc_bsdinfo check;
  if (!read_proc_bsd(member->pid, &check) || check.pbi_status == SZOMB) {
    return false;
  }
  if (proc_start_us(&check) != member->start_us) {
    *out_anomaly = true;
    return false;
  }
  (void)kill(member->pid, sig);
  return true;
}

struct ActivitySnapshot {
  bool has_active_child;
  int child_count;
  char foreground_command[128];
};

static struct ActivitySnapshot inspect_activity(
    int master_fd,
    pid_t shell_pid,
    pid_t shell_sid,
    uint64_t shell_start_us,
    struct KnownMemberTable *known,
    bool *out_anomaly) {
  struct ActivitySnapshot snap;
  memset(&snap, 0, sizeof(snap));

  pid_t fg_pgid = master_fd >= 0 ? tcgetpgrp(master_fd) : -1;
  struct SessionMember members[MAX_RELATED_PIDS];
  bool complete = true;
  size_t count = enumerate_session_members(
      shell_pid, shell_sid, shell_start_us, false, members, MAX_RELATED_PIDS, known, &complete, out_anomaly);
  snap.child_count = (int)count;
  snap.has_active_child = (count > 0) || (fg_pgid > 1 && fg_pgid != shell_pid) || !complete;

  const struct SessionMember *best = NULL;
  for (size_t i = 0; i < count; i++) {
    if (fg_pgid > 1 && fg_pgid != shell_pid && members[i].pgid == fg_pgid) {
      if (!best || members[i].start_us >= best->start_us) best = &members[i];
    }
  }
  if (!best && count > 0) {
    for (size_t i = 0; i < count; i++) {
      if (!best || members[i].start_us >= best->start_us) best = &members[i];
    }
  }
  if (best && best->command[0] != '\0') {
    snprintf(snap.foreground_command, sizeof(snap.foreground_command), "%s", best->command);
  }
  return snap;
}

static void enqueue_activity_frame(struct ByteQueue *out, const struct ActivitySnapshot *snap) {
  char escaped[300];
  char json[512];
  if (snap->foreground_command[0] != '\0') {
    json_escape(snap->foreground_command, escaped, sizeof(escaped));
    snprintf(
        json,
        sizeof(json),
        "{\"hasActiveChild\":%s,\"childCount\":%d,\"foregroundCommand\":\"%s\"}",
        snap->has_active_child ? "true" : "false",
        snap->child_count,
        escaped);
  } else {
    snprintf(
        json,
        sizeof(json),
        "{\"hasActiveChild\":%s,\"childCount\":%d,\"foregroundCommand\":null}",
        snap->has_active_child ? "true" : "false",
        snap->child_count);
  }
  (void)enqueue_frame(out, FRAME_ACTIVITY, (const uint8_t *)json, (uint32_t)strlen(json));
}

static void send_cooperative_shutdown(
    int master_fd,
    pid_t shell_pid,
    pid_t shell_sid,
    uint64_t shell_start_us,
    bool shell_exited,
    struct KnownMemberTable *known,
    bool *out_anomaly) {
  pid_t fg_pgid = master_fd >= 0 ? tcgetpgrp(master_fd) : -1;
  struct SessionMember members[MAX_RELATED_PIDS];
  bool complete = true;
  size_t count = enumerate_session_members(
      shell_pid, shell_sid, shell_start_us, !shell_exited, members, MAX_RELATED_PIDS, known, &complete, out_anomaly);

  // 1. Foreground group receives SIGINT; background groups receive SIGTERM; stopped jobs get SIGCONT.
  for (size_t i = 0; i < count; i++) {
    if (members[i].pid == shell_pid) continue;
    int sig = (fg_pgid > 1 && fg_pgid != shell_pid && members[i].pgid == fg_pgid) ? SIGINT : SIGTERM;
    (void)signal_verified_member(&members[i], shell_sid, sig, out_anomaly);
    if (members[i].status == SSTOP) {
      (void)signal_verified_member(&members[i], shell_sid, SIGCONT, out_anomaly);
    }
  }

  // 2. Login shell receives SIGHUP (plus SIGCONT if stopped).
  if (!shell_exited) {
    for (size_t i = 0; i < count; i++) {
      if (members[i].pid != shell_pid) continue;
      (void)signal_verified_member(&members[i], shell_sid, SIGHUP, out_anomaly);
      if (members[i].status == SSTOP) {
        (void)signal_verified_member(&members[i], shell_sid, SIGCONT, out_anomaly);
      }
      break;
    }
  }
}

static bool send_force_kill_session(
    pid_t shell_pid,
    pid_t shell_sid,
    uint64_t shell_start_us,
    bool shell_exited,
    struct KnownMemberTable *known,
    bool *out_anomaly) {
  struct SessionMember members[MAX_RELATED_PIDS];
  bool complete = true;
  size_t count = enumerate_session_members(
      shell_pid, shell_sid, shell_start_us, !shell_exited, members, MAX_RELATED_PIDS, known, &complete, out_anomaly);
  for (size_t i = 0; i < count; i++) {
    (void)signal_verified_member(&members[i], shell_sid, SIGKILL, out_anomaly);
  }
  return complete;
}

static const char *shell_basename(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

static bool verify_trusted_shell_path(const char *candidate, char *out_resolved, size_t out_cap) {
  if (!candidate || candidate[0] != '/') return false;
  char resolved[PATH_MAX];
  if (!realpath(candidate, resolved)) return false;

  struct stat st;
  if (stat(resolved, &st) != 0 || !S_ISREG(st.st_mode)) return false;
  if ((st.st_mode & (S_IWGRP | S_IWOTH)) != 0) return false;
  if (st.st_uid != 0 && st.st_uid != getuid()) return false;
  if (access(resolved, X_OK) != 0) return false;

  // Must match an entry in /etc/shells when resolving non-fallback shells.
  bool listed_in_etc_shells = false;
  setusershell();
  const char *entry;
  while ((entry = getusershell()) != NULL) {
    if (strcmp(entry, candidate) == 0 || strcmp(entry, resolved) == 0) {
      listed_in_etc_shells = true;
      break;
    }
    char entry_real[PATH_MAX];
    if (realpath(entry, entry_real) && strcmp(entry_real, resolved) == 0) {
      listed_in_etc_shells = true;
      break;
    }
  }
  endusershell();

  if (!listed_in_etc_shells &&
      strcmp(resolved, "/bin/zsh") != 0 &&
      strcmp(resolved, "/bin/bash") != 0 &&
      strcmp(resolved, "/bin/sh") != 0) {
    return false;
  }

  snprintf(out_resolved, out_cap, "%s", resolved);
  return true;
}

static bool resolve_account_shell(char *out_shell, size_t out_cap) {
  long bufsize = sysconf(_SC_GETPW_R_SIZE_MAX);
  if (bufsize <= 0 || bufsize > 65536) bufsize = 4096;
  char *pwbuf = calloc((size_t)bufsize, 1);
  if (pwbuf) {
    struct passwd pwd;
    struct passwd *pwres = NULL;
    if (getpwuid_r(getuid(), &pwd, pwbuf, (size_t)bufsize, &pwres) == 0 &&
        pwres && pwres->pw_shell &&
        verify_trusted_shell_path(pwres->pw_shell, out_shell, out_cap)) {
      free(pwbuf);
      return true;
    }
    free(pwbuf);
  }

  static const char *const fallbacks[] = {"/bin/zsh", "/bin/bash", "/bin/sh"};
  for (size_t i = 0; i < sizeof(fallbacks) / sizeof(fallbacks[0]); i++) {
    if (verify_trusted_shell_path(fallbacks[i], out_shell, out_cap)) {
      return true;
    }
  }
  return false;
}

static bool starts_with_ci(const char *str, const char *prefix) {
  while (*prefix) {
    if (tolower((unsigned char)*str) != tolower((unsigned char)*prefix)) return false;
    str++;
    prefix++;
  }
  return true;
}

static bool equals_key_ci(const char *entry, size_t key_len, const char *key) {
  return strlen(key) == key_len && strncasecmp(entry, key, key_len) == 0;
}

static bool should_strip_env_entry(const char *entry) {
  const char *eq = strchr(entry, '=');
  if (!eq || eq == entry) return true;
  size_t klen = (size_t)(eq - entry);

  if (starts_with_ci(entry, "PACT_") ||
      starts_with_ci(entry, "ELECTRON_") ||
      starts_with_ci(entry, "DYLD_") ||
      starts_with_ci(entry, "LD_") ||
      starts_with_ci(entry, "CHROME_") ||
      starts_with_ci(entry, "NODE_REPL_")) {
    return true;
  }
  static const char *const blocked_keys[] = {
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_PATH",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NODE_V8_COVERAGE",
      "GOOGLE_API_KEY",
      "ZDOTDIR",
      "PWD",
      "OLDPWD",
      "SHELL",
      "TERM",
      "COLORTERM",
      "TERM_PROGRAM",
  };
  for (size_t i = 0; i < sizeof(blocked_keys) / sizeof(blocked_keys[0]); i++) {
    if (equals_key_ci(entry, klen, blocked_keys[i])) return true;
  }
  return false;
}

static char **build_clean_env(const char *resolved_shell) {
  size_t count = 0;
  bool has_utf8_locale = false;
  if (environ) {
    for (size_t i = 0; environ[i] != NULL; i++) {
      count++;
      if ((starts_with_ci(environ[i], "LANG=") || starts_with_ci(environ[i], "LC_CTYPE=")) &&
          (strstr(environ[i], "UTF-8") != NULL || strstr(environ[i], "utf-8") != NULL)) {
        has_utf8_locale = true;
      }
    }
  }
  char **out = calloc(count + 8U, sizeof(char *));
  if (!out) return NULL;
  size_t idx = 0;
  if (environ) {
    for (size_t i = 0; environ[i] != NULL; i++) {
      if (should_strip_env_entry(environ[i])) continue;
      char *dup = strdup(environ[i]);
      if (dup) out[idx++] = dup;
    }
  }

  size_t shell_len = strlen(resolved_shell) + 8U;
  char *shell_kv = malloc(shell_len);
  if (shell_kv) {
    snprintf(shell_kv, shell_len, "SHELL=%s", resolved_shell);
    out[idx++] = shell_kv;
  }
  out[idx++] = strdup("TERM=xterm-256color");
  out[idx++] = strdup("COLORTERM=truecolor");
  out[idx++] = strdup("TERM_PROGRAM=Pact");
  if (!has_utf8_locale) {
    out[idx++] = strdup("LANG=en_US.UTF-8");
  }
  out[idx] = NULL;
  return out;
}

static void free_env(char **envp) {
  if (!envp) return;
  for (size_t i = 0; envp[i] != NULL; i++) free(envp[i]);
  free(envp);
}

static void print_usage_error(const char *code, const char *msg) {
  char emsg[512];
  char json[768];
  json_escape(msg, emsg, sizeof(emsg));
  snprintf(json, sizeof(json), "{\"code\":\"%s\",\"message\":\"%s\"}", code, emsg);
  write_frame_sync(STDOUT_FILENO, FRAME_ERROR, json);
}

int main(int argc, char **argv) {
  bool check_load = false;
  bool login_shell = true;
  const char *cwd = NULL;
  uint16_t cols = 80;
  uint16_t rows = 24;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--check-load") == 0) {
      check_load = true;
    } else if (strcmp(argv[i], "--login") == 0) {
      login_shell = true;
    } else if (strcmp(argv[i], "--no-login") == 0) {
      login_shell = false;
    } else if (strcmp(argv[i], "--shell") == 0 && i + 1 < argc) {
      // Shell binary is always resolved authoritatively from user account / system shells.
      i++;
    } else if (strcmp(argv[i], "--cwd") == 0 && i + 1 < argc) {
      cwd = argv[++i];
    } else if (strcmp(argv[i], "--cols") == 0 && i + 1 < argc) {
      long v = strtol(argv[++i], NULL, 10);
      if (v >= MIN_COLS && v <= MAX_COLS) cols = (uint16_t)v;
    } else if (strcmp(argv[i], "--rows") == 0 && i + 1 < argc) {
      long v = strtol(argv[++i], NULL, 10);
      if (v >= MIN_ROWS && v <= MAX_ROWS) rows = (uint16_t)v;
    }
  }

  if (check_load) {
    printf("{\"ok\":true,\"protocolVersion\":1}\n");
    return 0;
  }

  char resolved_cwd[PATH_MAX];
  struct stat cwd_st;
  if (!cwd || cwd[0] != '/' || !realpath(cwd, resolved_cwd) ||
      strcmp(resolved_cwd, cwd) != 0 ||
      stat(resolved_cwd, &cwd_st) != 0 || !S_ISDIR(cwd_st.st_mode)) {
    print_usage_error("VALIDATION", "Working directory is invalid or resolved through a symlink.");
    return 1;
  }

  char shell_path[PATH_MAX];
  if (!resolve_account_shell(shell_path, sizeof(shell_path))) {
    print_usage_error("RUNTIME_UNAVAILABLE", "No verified POSIX shell could be located.");
    return 1;
  }

  char **clean_env = build_clean_env(shell_path);
  if (!clean_env) {
    print_usage_error("INTERNAL", "Failed to prepare sanitized terminal environment.");
    return 1;
  }

  if (pipe(g_sigchld_pipe) != 0) {
    free_env(clean_env);
    print_usage_error("INTERNAL", "Failed to initialize helper signal pipe.");
    return 1;
  }
  (void)set_nonblocking(g_sigchld_pipe[0]);
  (void)set_nonblocking(g_sigchld_pipe[1]);
  (void)set_cloexec(g_sigchld_pipe[0]);
  (void)set_cloexec(g_sigchld_pipe[1]);

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_sigchld;
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  sigaction(SIGCHLD, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);

  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = cols;
  ws.ws_row = rows;

  int master_fd = -1;
  int slave_fd = -1;
  char slave_name[128] = {0};
  if (openpty(&master_fd, &slave_fd, slave_name, NULL, &ws) != 0) {
    free_env(clean_env);
    print_usage_error("INTERNAL", "Failed to allocate PTY device.");
    return 1;
  }
  (void)set_cloexec(master_fd);
  (void)set_cloexec(slave_fd);

  struct termios tio;
  if (tcgetattr(slave_fd, &tio) == 0) {
#ifdef IUTF8
    tio.c_iflag |= IUTF8;
#endif
    (void)tcsetattr(slave_fd, TCSANOW, &tio);
  }

  int err_pipe[2] = {-1, -1};
  int gate_pipe[2] = {-1, -1};
  if (pipe(err_pipe) != 0 || pipe(gate_pipe) != 0) {
    if (err_pipe[0] >= 0) { close(err_pipe[0]); close(err_pipe[1]); }
    close(master_fd);
    close(slave_fd);
    free_env(clean_env);
    print_usage_error("INTERNAL", "Failed to initialize fork coordination pipes.");
    return 1;
  }
  (void)set_cloexec(err_pipe[0]);
  (void)set_cloexec(err_pipe[1]);
  (void)set_cloexec(gate_pipe[0]);
  (void)set_cloexec(gate_pipe[1]);

  pid_t shell_pid = fork();
  if (shell_pid < 0) {
    close(master_fd);
    close(slave_fd);
    close(err_pipe[0]);
    close(err_pipe[1]);
    close(gate_pipe[0]);
    close(gate_pipe[1]);
    free_env(clean_env);
    print_usage_error("INTERNAL", "Failed to fork shell process.");
    return 1;
  }

  if (shell_pid == 0) {
    close(master_fd);
    close(err_pipe[0]);
    close(gate_pipe[1]);
    close(g_sigchld_pipe[0]);
    close(g_sigchld_pipe[1]);

    if (setsid() < 0 || ioctl(slave_fd, TIOCSCTTY, 0) < 0) {
      int err = errno;
      (void)write(err_pipe[1], &err, sizeof(err));
      _exit(126);
    }

    (void)dup2(slave_fd, STDIN_FILENO);
    (void)dup2(slave_fd, STDOUT_FILENO);
    (void)dup2(slave_fd, STDERR_FILENO);
    if (slave_fd > STDERR_FILENO) close(slave_fd);

    long open_max = sysconf(_SC_OPEN_MAX);
    if (open_max <= 0 || open_max > 4096) open_max = 4096;
    for (int fd = STDERR_FILENO + 1; fd < (int)open_max; fd++) {
      if (fd == err_pipe[1] || fd == gate_pipe[0]) continue;
      close(fd);
    }

    signal(SIGCHLD, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGQUIT, SIG_DFL);
    signal(SIGTSTP, SIG_DFL);
    signal(SIGTTIN, SIG_DFL);
    signal(SIGTTOU, SIG_DFL);

    if (chdir(resolved_cwd) != 0) {
      int err = errno;
      (void)write(err_pipe[1], &err, sizeof(err));
      _exit(126);
    }

    uint8_t go = 0;
    ssize_t gr;
    do {
      gr = read(gate_pipe[0], &go, 1);
    } while (gr < 0 && errno == EINTR);
    close(gate_pipe[0]);

    const char *base = shell_basename(shell_path);
    char argv0_buf[256];
    if (login_shell) {
      snprintf(argv0_buf, sizeof(argv0_buf), "-%s", base);
    } else {
      snprintf(argv0_buf, sizeof(argv0_buf), "%s", base);
    }
    char *child_argv[2];
    child_argv[0] = argv0_buf;
    child_argv[1] = NULL;
    execve(shell_path, child_argv, clean_env);

    int err = errno;
    (void)write(err_pipe[1], &err, sizeof(err));
    _exit(127);
  }

  free_env(clean_env);
  close(slave_fd);
  slave_fd = -1;
  close(err_pipe[1]);
  close(gate_pipe[0]);

  // Wait briefly until child has called setsid() so its birth SID and start timestamp are finalized.
  pid_t shell_sid = -1;
  uint64_t shell_start_us = 0;
  struct proc_bsdinfo shell_bsd;
  for (int i = 0; i < 40; i++) {
    pid_t sid_now = getsid(shell_pid);
    if (sid_now == shell_pid && read_proc_bsd(shell_pid, &shell_bsd)) {
      shell_sid = sid_now;
      shell_start_us = proc_start_us(&shell_bsd);
      if (shell_start_us > 0) break;
    }
    struct timespec ts = {.tv_sec = 0, .tv_nsec = 1000000L};
    nanosleep(&ts, NULL);
  }

  // Release the child to execve the shell.
  uint8_t go_byte = 1;
  (void)write(gate_pipe[1], &go_byte, 1);
  close(gate_pipe[1]);

  int child_errno = 0;
  ssize_t er;
  do {
    er = read(err_pipe[0], &child_errno, sizeof(child_errno));
  } while (er < 0 && errno == EINTR);
  close(err_pipe[0]);
  if (er > 0) {
    int status = 0;
    (void)waitpid(shell_pid, &status, 0);
    close(master_fd);
    print_usage_error("RUNTIME_UNAVAILABLE", strerror(child_errno));
    return 1;
  }

  if (shell_sid != shell_pid || shell_start_us == 0) {
    if (read_proc_bsd(shell_pid, &shell_bsd)) {
      shell_start_us = proc_start_us(&shell_bsd);
    }
    pid_t sid_now = getsid(shell_pid);
    if (sid_now == shell_pid) shell_sid = sid_now;
  }

  struct KnownMemberTable known;
  memset(&known, 0, sizeof(known));
  bool identity_anomaly = (shell_sid != shell_pid || shell_start_us == 0);
  if (!identity_anomaly) {
    known_record(&known, shell_pid, shell_start_us, &identity_anomaly);
  }

  (void)set_nonblocking(STDIN_FILENO);
  (void)set_nonblocking(STDOUT_FILENO);
  (void)set_nonblocking(master_fd);

  struct ByteQueue in_buf = {0};
  struct ByteQueue pty_out = {0};
  struct ByteQueue host_out = {0};

  char eshell[512];
  char ready_json[768];
  json_escape(shell_path, eshell, sizeof(eshell));
  snprintf(
      ready_json,
      sizeof(ready_json),
      "{\"protocolVersion\":1,\"pid\":%d,\"pgid\":%d,\"sid\":%d,\"startedAtMs\":%llu,\"shell\":\"%s\"}",
      (int)shell_pid,
      (int)shell_pid,
      (int)shell_sid,
      (unsigned long long)now_ms(),
      eshell);
  (void)enqueue_frame(&host_out, FRAME_READY, (const uint8_t *)ready_json, (uint32_t)strlen(ready_json));

  struct ActivitySnapshot last_activity;
  memset(&last_activity, 0, sizeof(last_activity));
  uint64_t last_activity_check = 0;

  bool shell_exited = false;
  bool shell_exited_emitted = false;
  int exit_code = -1;
  bool has_exit_code = false;
  int exit_sig = 0;
  bool pty_eof = false;
  bool stdin_eof = false;
  bool shutdown_requested = false;
  bool shutdown_force = false;
  bool cooperative_sent = false;
  bool force_kill_sent = false;
  bool pty_read_paused = false;
  uint64_t shutdown_deadline_ms = 0;
  uint64_t force_kill_at_ms = 0;

  for (;;) {
    if (!shell_exited) {
      int st = 0;
      pid_t w = waitpid(shell_pid, &st, WNOHANG);
      if (w == shell_pid) {
        shell_exited = true;
        if (WIFEXITED(st)) {
          exit_code = WEXITSTATUS(st);
          has_exit_code = true;
        } else if (WIFSIGNALED(st)) {
          exit_sig = WTERMSIG(st);
        }
        if (!shell_exited_emitted) {
          shell_exited_emitted = true;
          char code_buf[32], sig_buf[32], se_json[128];
          if (has_exit_code) snprintf(code_buf, sizeof(code_buf), "%d", exit_code);
          else snprintf(code_buf, sizeof(code_buf), "null");
          if (exit_sig > 0) snprintf(sig_buf, sizeof(sig_buf), "\"SIG%d\"", exit_sig);
          else snprintf(sig_buf, sizeof(sig_buf), "null");
          snprintf(se_json, sizeof(se_json), "{\"exitCode\":%s,\"signal\":%s}", code_buf, sig_buf);
          (void)enqueue_frame(
              &host_out, FRAME_SHELL_EXITED, (const uint8_t *)se_json, (uint32_t)strlen(se_json));
        }
      }
    }

    uint64_t now = now_ms();
    if (now - last_activity_check >= ACTIVITY_POLL_INTERVAL_MS) {
      last_activity_check = now;
      struct ActivitySnapshot cur =
          inspect_activity(master_fd, shell_pid, shell_sid, shell_start_us, &known, &identity_anomaly);
      if (cur.has_active_child != last_activity.has_active_child ||
          cur.child_count != last_activity.child_count ||
          strcmp(cur.foreground_command, last_activity.foreground_command) != 0) {
        last_activity = cur;
        enqueue_activity_frame(&host_out, &cur);
      }
    }

    if (shutdown_requested && !force_kill_sent && (shutdown_force || now >= shutdown_deadline_ms)) {
      force_kill_sent = true;
      force_kill_at_ms = now;
      (void)send_force_kill_session(
          shell_pid, shell_sid, shell_start_us, shell_exited, &known, &identity_anomaly);
    }

    struct SessionMember rem_members[MAX_RELATED_PIDS];
    bool rem_complete = true;
    size_t rcount = enumerate_session_members(
        shell_pid,
        shell_sid,
        shell_start_us,
        !shell_exited,
        rem_members,
        MAX_RELATED_PIDS,
        &known,
        &rem_complete,
        &identity_anomaly);

    if (shell_exited) {
      if (rem_complete && rcount == 0 && (pty_eof || master_fd < 0)) {
        break;
      }
      if (shutdown_requested && force_kill_sent && now >= force_kill_at_ms + 750ULL) {
        break;
      }
    } else if (shutdown_requested && force_kill_sent && now >= force_kill_at_ms + 750ULL) {
      break;
    }

    if (pty_read_paused && host_out.len <= HOST_OUT_RESUME_BYTES) {
      pty_read_paused = false;
    } else if (!pty_read_paused && host_out.len >= HOST_OUT_PAUSE_BYTES) {
      pty_read_paused = true;
    }

    struct pollfd fds[4];
    int nfds = 0;
    int idx_stdin = -1, idx_stdout = -1, idx_master = -1, idx_sig = -1;

    if (!stdin_eof && in_buf.len < MAX_IO_QUEUE_BYTES) {
      idx_stdin = nfds;
      fds[nfds++] = (struct pollfd){.fd = STDIN_FILENO, .events = POLLIN};
    }
    if (host_out.len > 0) {
      idx_stdout = nfds;
      fds[nfds++] = (struct pollfd){.fd = STDOUT_FILENO, .events = POLLOUT};
    }
    if (master_fd >= 0 && !pty_eof) {
      short ev = 0;
      if (!pty_read_paused) ev |= POLLIN;
      if (pty_out.len > 0) ev |= POLLOUT;
      if (ev != 0) {
        idx_master = nfds;
        fds[nfds++] = (struct pollfd){.fd = master_fd, .events = ev};
      }
    }
    idx_sig = nfds;
    fds[nfds++] = (struct pollfd){.fd = g_sigchld_pipe[0], .events = POLLIN};

    int timeout_ms = (shell_exited || shutdown_requested) ? 20 : 250;
    int pr = poll(fds, (nfds_t)nfds, timeout_ms);
    if (pr < 0) {
      if (errno == EINTR) continue;
      break;
    }

    if (idx_sig >= 0 && (fds[idx_sig].revents & POLLIN)) {
      drain_sigchld_pipe();
    }

    if (idx_stdin >= 0 && (fds[idx_stdin].revents & (POLLIN | POLLHUP | POLLERR))) {
      uint8_t chunk[32768];
      for (;;) {
        if (in_buf.len >= MAX_IO_QUEUE_BYTES) break;
        ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (n > 0) {
          if (!queue_append(&in_buf, chunk, (size_t)n)) {
            stdin_eof = true;
            shutdown_requested = true;
            shutdown_force = true;
            break;
          }
        } else if (n == 0) {
          stdin_eof = true;
          if (!shutdown_requested) {
            shutdown_requested = true;
            shutdown_deadline_ms = now_ms() + 2000ULL;
            if (!cooperative_sent) {
              cooperative_sent = true;
              send_cooperative_shutdown(
                  master_fd, shell_pid, shell_sid, shell_start_us, shell_exited, &known, &identity_anomaly);
            }
          }
          break;
        } else {
          if (errno == EINTR) continue;
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
          stdin_eof = true;
          break;
        }
      }

      while (in_buf.len >= 5) {
        uint8_t ftype = in_buf.data[0];
        uint32_t flen = ((uint32_t)in_buf.data[1] << 24) |
                        ((uint32_t)in_buf.data[2] << 16) |
                        ((uint32_t)in_buf.data[3] << 8) |
                        (uint32_t)in_buf.data[4];
        if (flen > MAX_FRAME_BYTES) {
          stdin_eof = true;
          shutdown_requested = true;
          shutdown_force = true;
          break;
        }
        if (in_buf.len < 5U + (size_t)flen) break;
        const uint8_t *payload = in_buf.data + 5;

        if (ftype == FRAME_INPUT && !pty_eof && !shell_exited && flen > 0) {
          if (pty_out.len + flen <= MAX_IO_QUEUE_BYTES) {
            (void)queue_append(&pty_out, payload, flen);
          }
        } else if (ftype == FRAME_RESIZE && flen == 4 && master_fd >= 0) {
          uint16_t nc = (uint16_t)(((uint16_t)payload[0] << 8) | payload[1]);
          uint16_t nr = (uint16_t)(((uint16_t)payload[2] << 8) | payload[3]);
          if (nc >= MIN_COLS && nc <= MAX_COLS && nr >= MIN_ROWS && nr <= MAX_ROWS) {
            ws.ws_col = nc;
            ws.ws_row = nr;
            (void)ioctl(master_fd, TIOCSWINSZ, &ws);
          }
        } else if (ftype == FRAME_SHUTDOWN && flen >= 5) {
          shutdown_requested = true;
          shutdown_force = payload[0] != 0;
          uint32_t grace_ms = ((uint32_t)payload[1] << 24) |
                              ((uint32_t)payload[2] << 16) |
                              ((uint32_t)payload[3] << 8) |
                              (uint32_t)payload[4];
          if (grace_ms > 10000U) grace_ms = 10000U;
          shutdown_deadline_ms = now_ms() + (uint64_t)grace_ms;
          if (shutdown_force) {
            force_kill_sent = true;
            force_kill_at_ms = now_ms();
            (void)send_force_kill_session(
                shell_pid, shell_sid, shell_start_us, shell_exited, &known, &identity_anomaly);
          } else if (!cooperative_sent) {
            cooperative_sent = true;
            send_cooperative_shutdown(
                master_fd, shell_pid, shell_sid, shell_start_us, shell_exited, &known, &identity_anomaly);
          }
        } else if (ftype == FRAME_PING_ACTIVITY) {
          struct ActivitySnapshot cur = inspect_activity(
              master_fd, shell_pid, shell_sid, shell_start_us, &known, &identity_anomaly);
          last_activity = cur;
          last_activity_check = now_ms();
          enqueue_activity_frame(&host_out, &cur);
        }

        queue_consume(&in_buf, 5U + (size_t)flen);
      }
    }

    if (idx_master >= 0) {
      if ((fds[idx_master].revents & POLLOUT) && pty_out.len > 0) {
        while (pty_out.len > 0) {
          ssize_t wn = write(master_fd, pty_out.data, pty_out.len);
          if (wn > 0) {
            queue_consume(&pty_out, (size_t)wn);
          } else if (wn < 0 && errno == EINTR) {
            continue;
          } else if (wn < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            break;
          } else {
            pty_out.len = 0;
            break;
          }
        }
      }
      if ((fds[idx_master].revents & (POLLIN | POLLHUP | POLLERR)) &&
          host_out.len < HOST_OUT_PAUSE_BYTES) {
        uint8_t pbuf[32768];
        while (host_out.len < HOST_OUT_PAUSE_BYTES) {
          ssize_t rn = read(master_fd, pbuf, sizeof(pbuf));
          if (rn > 0) {
            (void)enqueue_frame(&host_out, FRAME_OUTPUT, pbuf, (uint32_t)rn);
          } else if (rn == 0) {
            pty_eof = true;
            break;
          } else {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            pty_eof = true;
            break;
          }
        }
      }
    }

    if (idx_stdout >= 0 && (fds[idx_stdout].revents & POLLOUT) && host_out.len > 0) {
      while (host_out.len > 0) {
        ssize_t wn = write(STDOUT_FILENO, host_out.data, host_out.len);
        if (wn > 0) {
          queue_consume(&host_out, (size_t)wn);
        } else if (wn < 0 && errno == EINTR) {
          continue;
        } else if (wn < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
          break;
        } else {
          host_out.len = 0;
          break;
        }
      }
    }
  }

  // Final bounded drain on PTY if open and buffer has room.
  if (master_fd >= 0) {
    uint8_t tail[8192];
    while (host_out.len < HOST_OUT_PAUSE_BYTES) {
      ssize_t rn = read(master_fd, tail, sizeof(tail));
      if (rn > 0) {
        (void)enqueue_frame(&host_out, FRAME_OUTPUT, tail, (uint32_t)rn);
      } else {
        break;
      }
    }
    close(master_fd);
    master_fd = -1;
  }

  if (!shell_exited) {
    int st = 0;
    if (waitpid(shell_pid, &st, WNOHANG) == shell_pid) {
      shell_exited = true;
      if (WIFEXITED(st)) {
        exit_code = WEXITSTATUS(st);
        has_exit_code = true;
      } else if (WIFSIGNALED(st)) {
        exit_sig = WTERMSIG(st);
      }
    }
  }

  struct SessionMember final_members[MAX_RELATED_PIDS];
  bool enum_complete = true;
  size_t rem_count = enumerate_session_members(
      shell_pid,
      shell_sid,
      shell_start_us,
      !shell_exited,
      final_members,
      MAX_RELATED_PIDS,
      &known,
      &enum_complete,
      &identity_anomaly);

  if (rem_count > 0 && shutdown_requested) {
    (void)send_force_kill_session(
        shell_pid, shell_sid, shell_start_us, shell_exited, &known, &identity_anomaly);
    struct timespec wait_ts = {.tv_sec = 0, .tv_nsec = 40000000L};
    nanosleep(&wait_ts, NULL);
    if (!shell_exited) {
      int st = 0;
      if (waitpid(shell_pid, &st, WNOHANG) == shell_pid) {
        shell_exited = true;
        if (WIFEXITED(st)) {
          exit_code = WEXITSTATUS(st);
          has_exit_code = true;
        } else if (WIFSIGNALED(st)) {
          exit_sig = WTERMSIG(st);
        }
      }
    }
    rem_count = enumerate_session_members(
        shell_pid,
        shell_sid,
        shell_start_us,
        !shell_exited,
        final_members,
        MAX_RELATED_PIDS,
        &known,
        &enum_complete,
        &identity_anomaly);
  }

  bool cleanup_confirmed = enum_complete && !identity_anomaly && (rem_count == 0) && shell_exited;

  if (host_out.len > 0) {
    (void)write_all_blocking(STDOUT_FILENO, host_out.data, host_out.len);
    host_out.len = 0;
  }

  char code_str[32];
  char sig_str[32];
  if (has_exit_code) {
    snprintf(code_str, sizeof(code_str), "%d", exit_code);
  } else {
    snprintf(code_str, sizeof(code_str), "null");
  }
  if (exit_sig > 0) {
    snprintf(sig_str, sizeof(sig_str), "\"SIG%d\"", exit_sig);
  } else {
    snprintf(sig_str, sizeof(sig_str), "null");
  }

  char exit_json[256];
  snprintf(
      exit_json,
      sizeof(exit_json),
      "{\"exitCode\":%s,\"signal\":%s,\"cleanupConfirmed\":%s,\"remainingPids\":%zu,\"enumerationComplete\":%s,\"identityAnomaly\":%s}",
      code_str,
      sig_str,
      cleanup_confirmed ? "true" : "false",
      rem_count,
      enum_complete ? "true" : "false",
      identity_anomaly ? "true" : "false");
  write_frame_sync(STDOUT_FILENO, FRAME_EXIT, exit_json);

  free(in_buf.data);
  free(pty_out.data);
  free(host_out.data);
  close(g_sigchld_pipe[0]);
  close(g_sigchld_pipe[1]);
  return 0;
}
