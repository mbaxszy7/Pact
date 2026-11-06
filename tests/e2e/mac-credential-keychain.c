#include <Security/Security.h>
#include <Security/cssmapple.h>
#include <Security/cssmapi.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int created_by_this_process = 0;

/* Bounded JSON: stage/status/booleans only — never data, paths or secrets. */
static int fail(const char *stage, OSStatus status) {
  printf("{\"ok\":false,\"stage\":\"%s\",\"status\":%d,\"created\":%s}\n",
         stage, (int)status, created_by_this_process ? "true" : "false");
  return 2;
}

/* 0 absent, 1 present, -1 unknown (never deleted:true on unknown). */
static int presence(const char *path) {
  struct stat st;
  if (lstat(path, &st) == 0) return 1;
  return errno == ENOENT ? 0 : -1;
}

/* Owned UID, mode 0700, real directory, and canonical path (catches ancestor symlinks). */
static int directory(const char *path) {
  struct stat st;
  char canonical[PATH_MAX];
  return lstat(path, &st) == 0 && S_ISDIR(st.st_mode) &&
         st.st_uid == getuid() && (st.st_mode & 0777) == 0700 &&
         realpath(path, canonical) && !strcmp(canonical, path);
}

/* Owned regular file, single link, no symlink, canonical exact expected path. */
static int ownedFile(const char *path, const char *expected) {
  struct stat st;
  char canonical[PATH_MAX];
  return lstat(path, &st) == 0 && S_ISREG(st.st_mode) &&
         st.st_uid == getuid() && st.st_nlink == 1 &&
         realpath(path, canonical) && !strcmp(canonical, expected);
}

int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "create") && strcmp(argv[1], "delete")))
    return 3;
  char home[PATH_MAX], path[PATH_MAX], variant[PATH_MAX], prefs[PATH_MAX], parent[PATH_MAX];
  {
    const char *requested = getenv("HOME");
    struct passwd *account = getpwuid(getuid());
    const char *slash;
    if (!requested || strlen(requested) > PATH_MAX - 128 || !account ||
        !realpath(requested, home) || strcmp(home, requested) ||
        !strcmp(home, account->pw_dir) ||
        strlen(home) <= 5 || strcmp(home + strlen(home) - 5, "/home") ||
        !directory(home))
      return fail("home", -1);
    /* Immediate parent basename must start pact-runtime-e2e-. */
    slash = home + strlen(home) - 5;
    /* find start of parent component (before trailing '/home') */
    {
      const char *end = slash; /* points at '/' before "home" */
      const char *start = end;
      while (start > home && start[-1] != '/') start--;
      if ((size_t)(end - start) < strlen("pact-runtime-e2e-") ||
          strncmp(start, "pact-runtime-e2e-", strlen("pact-runtime-e2e-")))
        return fail("home", -1);
    }
  }
  snprintf(parent, sizeof(parent), "%s/Library", home);
  if (!directory(parent)) return fail("library-directory", -1);
  snprintf(parent, sizeof(parent), "%s/Library/Keychains", home);
  if (!directory(parent)) return fail("keychain-directory", -1);
  snprintf(parent, sizeof(parent), "%s/Library/Preferences", home);
  if (!directory(parent)) return fail("preferences-directory", -1);
  snprintf(path, sizeof(path), "%s/Library/Keychains/relay-fixture.keychain", home);
  snprintf(variant, sizeof(variant), "%s/Library/Keychains/relay-fixture.keychain-db", home);
  snprintf(prefs, sizeof(prefs), "%s/Library/Preferences/com.apple.security.plist", home);
  OSStatus result = SecKeychainSetUserInteractionAllowed(false);
  if (result != errSecSuccess) return fail("interaction", result);
  if (!strcmp(argv[1], "delete")) {
    int present = presence(path), variantPresent = presence(variant);
    if (present < 0 || variantPresent < 0) return fail("keychain-target", -1);
    if (!present && !variantPresent) {
      int prefsPresent = presence(prefs);
      if (prefsPresent < 0) return fail("keychain-target", -1);
      if (prefsPresent && unlink(prefs) != 0) return fail("keychain-target", -1);
      puts("{\"ok\":true,\"deleted\":true,\"alreadyGone\":true}");
      return 0;
    }
    /* Reject unexpected targets BEFORE SecKeychainOpen. */
    if ((present && !ownedFile(path, path)) ||
        (variantPresent && !ownedFile(variant, variant)))
      return fail("keychain-target", -1);
    /* Remove only our private reference before native deletion; no default/list setter. */
    if (unlink(prefs) != 0 && errno != ENOENT) return fail("keychain-target", -1);
    SecKeychainRef owned = NULL;
    result = SecKeychainOpen(path, &owned);
    if (result == errSecSuccess) result = SecKeychainDelete(owned);
    if (owned) CFRelease(owned);
    if (result != errSecSuccess && result != errSecNoSuchKeychain)
      return fail("delete", result);
    if (presence(path) != 0 || presence(variant) != 0 || presence(prefs) != 0)
      return fail("delete-verify", -1);
    puts("{\"ok\":true,\"deleted\":true}");
    return 0;
  }
  if (presence(prefs) != 0 || presence(path) != 0 || presence(variant) != 0)
    return fail("already-exists", -1);
  unsigned char random[32];
  char password[65];
  OSStatus randomStatus = SecRandomCopyBytes(kSecRandomDefault, sizeof(random), random);
  if (randomStatus != errSecSuccess) return fail("random", randomStatus);
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(random); i++) {
    password[2*i] = hex[random[i] >> 4];
    password[2*i+1] = hex[random[i] & 15];
  }
  password[64] = '\0';
  size_t length = 64;
  SecKeychainRef owned = NULL;
  result = SecKeychainCreate(path, (UInt32)length, password, false, NULL, &owned);
  if (result == errSecSuccess) {
    created_by_this_process = 1;
    result = SecKeychainUnlock(owned, (UInt32)length, password, true);
  }
  volatile unsigned char *wipeRandom = random;
  for (size_t index = 0; index < sizeof(random); index++) wipeRandom[index] = 0;
  volatile char *wipe = password;
  for (size_t index = 0; index < sizeof(password); index++) wipe[index] = 0;
  if (result != errSecSuccess) {
    if (owned) CFRelease(owned);
    return fail("create-unlock", result);
  }
  char actual[PATH_MAX];
  UInt32 actualLength = sizeof(actual);
  result = SecKeychainGetPath(owned, &actualLength, actual);
  if (result != errSecSuccess || actualLength >= sizeof(actual)) {
    CFRelease(owned);
    return fail("private-path", result);
  }
  actual[actualLength] = '\0';
  if (strncmp(actual, path, strlen(path)) ||
      (strcmp(actual + strlen(path), "") && strcmp(actual + strlen(path), "-db"))) {
    CFRelease(owned);
    return fail("private-path-scope", -1);
  }
  CSSM_DL_DB_HANDLE handles;
  CSSM_GUID guid;
  result = SecKeychainGetDLDBHandle(owned, &handles);
  if (result == errSecSuccess)
    result = CSSM_GetModuleGUIDFromHandle(handles.DLHandle, &guid);
  if (result != errSecSuccess || memcmp(&guid, &gGuidAppleCSPDL, sizeof(guid))) {
    CFRelease(owned);
    return fail("private-provider", result);
  }
  char identifier[39];
  snprintf(identifier, sizeof(identifier),
    "{%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x}",
    (unsigned)ntohl(guid.Data1), ntohs(guid.Data2), ntohs(guid.Data3), guid.Data4[0], guid.Data4[1],
    guid.Data4[2], guid.Data4[3], guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7]);
  CFStringRef dbName = CFStringCreateWithCString(NULL, actual, kCFStringEncodingUTF8);
  CFStringRef provider = CFStringCreateWithCString(NULL, identifier, kCFStringEncodingASCII);
  int service = CSSM_SERVICE_DL | CSSM_SERVICE_CSP;
  CFNumberRef type = CFNumberCreate(NULL, kCFNumberIntType, &service);
  const void *entryKeys[] = { CFSTR("DbName"), CFSTR("GUID"), CFSTR("SubserviceType") };
  const void *entryValues[] = { dbName, provider, type };
  CFDictionaryRef entry = CFDictionaryCreate(NULL, entryKeys, entryValues, 3,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  const void *items[] = { entry };
  CFArrayRef list = CFArrayCreate(NULL, items, 1, &kCFTypeArrayCallBacks);
  const void *keys[] = { CFSTR("DefaultKeychain"), CFSTR("DLDBSearchList") };
  const void *values[] = { list, list };
  CFDictionaryRef plist = CFDictionaryCreate(NULL, keys, values, 2,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDataRef data = CFPropertyListCreateData(NULL, plist, kCFPropertyListXMLFormat_v1_0, 0, NULL);
  int fd = open(prefs, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  int written = 0;
  if (fd >= 0 && data) {
    CFIndex bytes = CFDataGetLength(data);
    written = bytes > 0 && bytes < 8192 &&
      write(fd, CFDataGetBytePtr(data), (size_t)bytes) == bytes && fsync(fd) == 0;
  }
  if (fd >= 0) close(fd);
  if (data) CFRelease(data);
  CFRelease(plist); CFRelease(list); CFRelease(entry);
  CFRelease(type); CFRelease(provider); CFRelease(dbName); CFRelease(owned);
  if (!written) return fail("private-preferences", -1);
  puts("{\"ok\":true,\"created\":true}");
  return 0;
}
