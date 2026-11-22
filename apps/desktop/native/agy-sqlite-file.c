/*
 * Self-contained C11 N-API v8 native anchored file reader & SQLite-VFS-compatible
 * SHARED byte-range locking module for Antigravity SQLite storage.
 *
 * Zero external headers (<node_api.h>), zero node.lib, zero node-gyp:
 * - POSIX (macOS/Linux): resolves N-API v8 symbols dynamically from the host runtime.
 * - Windows (MSVC /LD /MT /guard:cf): resolves N-API v8 symbols at load time via
 *   GetModuleHandleW(NULL) + GetProcAddress so one binary loads identically in
 *   node.exe (Vitest), electron.exe, and packaged Pact.exe UtilityProcess.
 */

#if !defined(_WIN32)
#  if !defined(_POSIX_C_SOURCE)
#    define _POSIX_C_SOURCE 200809L
#  endif
#  if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#    define _DARWIN_C_SOURCE 1
#  endif
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <errno.h>
#  include <fcntl.h>
#  include <limits.h>
#  include <pthread.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <unistd.h>
#endif

#ifndef PACT_AGY_SQLITE_FILE_SOURCE_SHA256
#  define PACT_AGY_SQLITE_FILE_SOURCE_SHA256 "unknown"
#endif

#if defined(_WIN32)
#  define AGY_PLATFORM "win32"
#elif defined(__APPLE__)
#  define AGY_PLATFORM "darwin"
#else
#  define AGY_PLATFORM "linux"
#endif

#if defined(__aarch64__) || defined(_M_ARM64)
#  define AGY_ARCH "arm64"
#elif defined(__x86_64__) || defined(_M_X64)
#  define AGY_ARCH "x64"
#else
#  define AGY_ARCH "unknown"
#endif

/* ============================================================================
 * Minimal Frozen N-API v8 C ABI Declarations (Zero <node_api.h> Dependency)
 * ============================================================================ */

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_ref__* napi_ref;
typedef struct napi_callback_info__* napi_callback_info;

typedef enum {
  napi_ok = 0,
  napi_invalid_arg,
  napi_object_expected,
  napi_string_expected,
  napi_name_expected,
  napi_function_expected,
  napi_number_expected,
  napi_boolean_expected,
  napi_array_expected,
  napi_generic_failure,
  napi_pending_exception,
  napi_cancelled,
  napi_escape_called_twice,
  napi_handle_scope_mismatch,
  napi_callback_scope_mismatch,
  napi_queue_full,
  napi_closing,
  napi_bigint_expected,
  napi_date_expected,
  napi_arraybuffer_expected,
  napi_detachable_arraybuffer_expected,
  napi_would_deadlock,
  napi_no_external_buffers_allowed,
  napi_cannot_run_js
} napi_status;

typedef enum {
  napi_undefined = 0,
  napi_null,
  napi_boolean,
  napi_number,
  napi_string,
  napi_symbol,
  napi_object,
  napi_function,
  napi_external,
  napi_bigint
} napi_valuetype;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void* finalize_data, void* finalize_hint);

#define NAPI_AUTO_LENGTH ((size_t)-1)

#if defined(_WIN32)

typedef napi_status (*pfn_napi_get_cb_info)(
    napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef napi_status (*pfn_napi_typeof)(napi_env, napi_value, napi_valuetype*);
typedef napi_status (*pfn_napi_is_array)(napi_env, napi_value, bool*);
typedef napi_status (*pfn_napi_get_array_length)(napi_env, napi_value, uint32_t*);
typedef napi_status (*pfn_napi_get_element)(napi_env, napi_value, uint32_t, napi_value*);
typedef napi_status (*pfn_napi_get_value_string_utf8)(napi_env, napi_value, char*, size_t, size_t*);
typedef napi_status (*pfn_napi_get_value_bool)(napi_env, napi_value, bool*);
typedef napi_status (*pfn_napi_get_value_int64)(napi_env, napi_value, int64_t*);
typedef napi_status (*pfn_napi_get_value_double)(napi_env, napi_value, double*);
typedef napi_status (*pfn_napi_has_named_property)(napi_env, napi_value, const char*, bool*);
typedef napi_status (*pfn_napi_get_named_property)(napi_env, napi_value, const char*, napi_value*);
typedef napi_status (*pfn_napi_set_named_property)(napi_env, napi_value, const char*, napi_value);
typedef napi_status (*pfn_napi_create_object)(napi_env, napi_value*);
typedef napi_status (*pfn_napi_create_string_utf8)(napi_env, const char*, size_t, napi_value*);
typedef napi_status (*pfn_napi_create_int64)(napi_env, int64_t, napi_value*);
typedef napi_status (*pfn_napi_create_double)(napi_env, double, napi_value*);
typedef napi_status (*pfn_napi_get_boolean)(napi_env, bool, napi_value*);
typedef napi_status (*pfn_napi_get_null)(napi_env, napi_value*);
typedef napi_status (*pfn_napi_get_undefined)(napi_env, napi_value*);
typedef napi_status (*pfn_napi_create_function)(
    napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef napi_status (*pfn_napi_create_buffer)(napi_env, size_t, void**, napi_value*);
typedef napi_status (*pfn_napi_wrap)(
    napi_env, napi_value, void*, napi_finalize, void*, napi_ref*);
typedef napi_status (*pfn_napi_unwrap)(napi_env, napi_value, void**);
typedef napi_status (*pfn_napi_create_error)(napi_env, napi_value, napi_value, napi_value*);
typedef napi_status (*pfn_napi_throw)(napi_env, napi_value);
typedef napi_status (*pfn_napi_throw_type_error)(napi_env, const char*, const char*);

typedef struct {
  pfn_napi_get_cb_info get_cb_info;
  pfn_napi_typeof typeof_fn;
  pfn_napi_is_array is_array;
  pfn_napi_get_array_length get_array_length;
  pfn_napi_get_element get_element;
  pfn_napi_get_value_string_utf8 get_value_string_utf8;
  pfn_napi_get_value_bool get_value_bool;
  pfn_napi_get_value_int64 get_value_int64;
  pfn_napi_get_value_double get_value_double;
  pfn_napi_has_named_property has_named_property;
  pfn_napi_get_named_property get_named_property;
  pfn_napi_set_named_property set_named_property;
  pfn_napi_create_object create_object;
  pfn_napi_create_string_utf8 create_string_utf8;
  pfn_napi_create_int64 create_int64;
  pfn_napi_create_double create_double;
  pfn_napi_get_boolean get_boolean;
  pfn_napi_get_null get_null;
  pfn_napi_get_undefined get_undefined;
  pfn_napi_create_function create_function;
  pfn_napi_create_buffer create_buffer;
  pfn_napi_wrap wrap;
  pfn_napi_unwrap unwrap;
  pfn_napi_create_error create_error;
  pfn_napi_throw throw_fn;
  pfn_napi_throw_type_error throw_type_error;
} AgyNapiTable;

static AgyNapiTable g_napi;

static FARPROC agy_resolve_napi_symbol(HMODULE main_mod, HMODULE node_dll, const char* name) {
  FARPROC fn = main_mod ? GetProcAddress(main_mod, name) : NULL;
  if (!fn && node_dll) fn = GetProcAddress(node_dll, name);
  return fn;
}

static bool agy_init_napi_table(void) {
  HMODULE main_mod = GetModuleHandleW(NULL);
  HMODULE node_dll = GetModuleHandleW(L"node.dll");
#  define RESOLVE_NAPI(field, sym)                                                              \
    do {                                                                                        \
      FARPROC raw_fn__ = agy_resolve_napi_symbol(main_mod, node_dll, #sym);                     \
      if (!raw_fn__) return false;                                                              \
      memcpy(&g_napi.field, &raw_fn__, sizeof(raw_fn__));                                       \
    } while (0)
  RESOLVE_NAPI(get_cb_info, napi_get_cb_info);
  RESOLVE_NAPI(typeof_fn, napi_typeof);
  RESOLVE_NAPI(is_array, napi_is_array);
  RESOLVE_NAPI(get_array_length, napi_get_array_length);
  RESOLVE_NAPI(get_element, napi_get_element);
  RESOLVE_NAPI(get_value_string_utf8, napi_get_value_string_utf8);
  RESOLVE_NAPI(get_value_bool, napi_get_value_bool);
  RESOLVE_NAPI(get_value_int64, napi_get_value_int64);
  RESOLVE_NAPI(get_value_double, napi_get_value_double);
  RESOLVE_NAPI(has_named_property, napi_has_named_property);
  RESOLVE_NAPI(get_named_property, napi_get_named_property);
  RESOLVE_NAPI(set_named_property, napi_set_named_property);
  RESOLVE_NAPI(create_object, napi_create_object);
  RESOLVE_NAPI(create_string_utf8, napi_create_string_utf8);
  RESOLVE_NAPI(create_int64, napi_create_int64);
  RESOLVE_NAPI(create_double, napi_create_double);
  RESOLVE_NAPI(get_boolean, napi_get_boolean);
  RESOLVE_NAPI(get_null, napi_get_null);
  RESOLVE_NAPI(get_undefined, napi_get_undefined);
  RESOLVE_NAPI(create_function, napi_create_function);
  RESOLVE_NAPI(create_buffer, napi_create_buffer);
  RESOLVE_NAPI(wrap, napi_wrap);
  RESOLVE_NAPI(unwrap, napi_unwrap);
  RESOLVE_NAPI(create_error, napi_create_error);
  RESOLVE_NAPI(throw_fn, napi_throw);
  RESOLVE_NAPI(throw_type_error, napi_throw_type_error);
#  undef RESOLVE_NAPI
  return true;
}

#  define napi_get_cb_info g_napi.get_cb_info
#  define napi_typeof g_napi.typeof_fn
#  define napi_is_array g_napi.is_array
#  define napi_get_array_length g_napi.get_array_length
#  define napi_get_element g_napi.get_element
#  define napi_get_value_string_utf8 g_napi.get_value_string_utf8
#  define napi_get_value_bool g_napi.get_value_bool
#  define napi_get_value_int64 g_napi.get_value_int64
#  define napi_get_value_double g_napi.get_value_double
#  define napi_has_named_property g_napi.has_named_property
#  define napi_get_named_property g_napi.get_named_property
#  define napi_set_named_property g_napi.set_named_property
#  define napi_create_object g_napi.create_object
#  define napi_create_string_utf8 g_napi.create_string_utf8
#  define napi_create_int64 g_napi.create_int64
#  define napi_create_double g_napi.create_double
#  define napi_get_boolean g_napi.get_boolean
#  define napi_get_null g_napi.get_null
#  define napi_get_undefined g_napi.get_undefined
#  define napi_create_function g_napi.create_function
#  define napi_create_buffer g_napi.create_buffer
#  define napi_wrap g_napi.wrap
#  define napi_unwrap g_napi.unwrap
#  define napi_create_error g_napi.create_error
#  define napi_throw g_napi.throw_fn
#  define napi_throw_type_error g_napi.throw_type_error

#else /* POSIX */

extern napi_status napi_get_cb_info(
    napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
extern napi_status napi_typeof(napi_env, napi_value, napi_valuetype*);
extern napi_status napi_is_array(napi_env, napi_value, bool*);
extern napi_status napi_get_array_length(napi_env, napi_value, uint32_t*);
extern napi_status napi_get_element(napi_env, napi_value, uint32_t, napi_value*);
extern napi_status napi_get_value_string_utf8(napi_env, napi_value, char*, size_t, size_t*);
extern napi_status napi_get_value_bool(napi_env, napi_value, bool*);
extern napi_status napi_get_value_int64(napi_env, napi_value, int64_t*);
extern napi_status napi_get_value_double(napi_env, napi_value, double*);
extern napi_status napi_has_named_property(napi_env, napi_value, const char*, bool*);
extern napi_status napi_get_named_property(napi_env, napi_value, const char*, napi_value*);
extern napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
extern napi_status napi_create_object(napi_env, napi_value*);
extern napi_status napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);
extern napi_status napi_create_int64(napi_env, int64_t, napi_value*);
extern napi_status napi_create_double(napi_env, double, napi_value*);
extern napi_status napi_get_boolean(napi_env, bool, napi_value*);
extern napi_status napi_get_null(napi_env, napi_value*);
extern napi_status napi_get_undefined(napi_env, napi_value*);
extern napi_status napi_create_function(
    napi_env, const char*, size_t, napi_callback, void*, napi_value*);
extern napi_status napi_create_buffer(napi_env, size_t, void**, napi_value*);
extern napi_status napi_wrap(
    napi_env, napi_value, void*, napi_finalize, void*, napi_ref*);
extern napi_status napi_unwrap(napi_env, napi_value, void**);
extern napi_status napi_create_error(napi_env, napi_value, napi_value, napi_value*);
extern napi_status napi_throw(napi_env, napi_value);
extern napi_status napi_throw_type_error(napi_env, const char*, const char*);

#endif

/* ============================================================================
 * Constants & Shared Helpers
 * ============================================================================ */

#define AGY_MAX_PARENT_SEGMENTS 8
#define AGY_MAX_PATH_BYTES 4096
#define AGY_MAX_NAME_BYTES 255
#define AGY_MAX_READ_BYTES (64 * 1024 * 1024)

/* SQLite VFS byte-range locking protocol constants (lockingv3.html) */
#define SQLITE_PENDING_BYTE 0x40000000
#define SQLITE_SHARED_FIRST 0x40000002
#define SQLITE_SHARED_SIZE 510
#define SQLITE_LOCK_SPAN 512

static napi_value throw_coded_error(
    napi_env env, const char* code, const char* stage, const char* message) {
  napi_value code_val = NULL;
  napi_value msg_val = NULL;
  napi_value stage_val = NULL;
  napi_value err_val = NULL;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_val) != napi_ok ||
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg_val) != napi_ok ||
      napi_create_error(env, code_val, msg_val, &err_val) != napi_ok) {
    return NULL;
  }
  napi_set_named_property(env, err_val, "code", code_val);
  if (stage != NULL &&
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &stage_val) == napi_ok) {
    napi_set_named_property(env, err_val, "stage", stage_val);
  }
  napi_throw(env, err_val);
  return NULL;
}

static bool is_valid_segment(const char* name) {
  size_t len = strlen(name);
  if (len == 0 || len > AGY_MAX_NAME_BYTES) return false;
  if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return false;
  for (size_t i = 0; i < len; i++) {
    if (name[i] == '/' || name[i] == '\\' || name[i] == '\0') return false;
#if defined(_WIN32)
    if (name[i] == ':') return false;
#endif
  }
  return true;
}

static char* dup_js_string(napi_env env, napi_value val, size_t max_len) {
  napi_valuetype t = napi_undefined;
  if (napi_typeof(env, val, &t) != napi_ok || t != napi_string) return NULL;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, val, NULL, 0, &len) != napi_ok) return NULL;
  if (len == 0 || len > max_len) return NULL;
  char* buf = (char*)malloc(len + 1);
  if (!buf) return NULL;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, val, buf, len + 1, &copied) != napi_ok || copied != len) {
    free(buf);
    return NULL;
  }
  if (strlen(buf) != len) {
    /* Reject embedded NUL bytes. */
    free(buf);
    return NULL;
  }
  return buf;
}

static char* concat_suffix(const char* base, const char* suffix) {
  size_t a = strlen(base);
  size_t b = strlen(suffix);
  char* out = (char*)malloc(a + b + 1);
  if (!out) return NULL;
  memcpy(out, base, a);
  memcpy(out + a, suffix, b + 1);
  return out;
}

static bool get_opt_bool(napi_env env, napi_value opts, const char* key, bool fallback) {
  if (!opts) return fallback;
  napi_valuetype ot = napi_undefined;
  if (napi_typeof(env, opts, &ot) != napi_ok || ot != napi_object) return fallback;
  bool has = false;
  if (napi_has_named_property(env, opts, key, &has) != napi_ok || !has) return fallback;
  napi_value prop = NULL;
  if (napi_get_named_property(env, opts, key, &prop) != napi_ok) return fallback;
  napi_valuetype pt = napi_undefined;
  if (napi_typeof(env, prop, &pt) != napi_ok || pt != napi_boolean) return fallback;
  bool out = fallback;
  if (napi_get_value_bool(env, prop, &out) != napi_ok) return fallback;
  return out;
}

static void set_str_prop(napi_env env, napi_value obj, const char* key, const char* val) {
  napi_value v = NULL;
  if (napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v) == napi_ok) {
    napi_set_named_property(env, obj, key, v);
  }
}

static void set_bool_prop(napi_env env, napi_value obj, const char* key, bool val) {
  napi_value v = NULL;
  if (napi_get_boolean(env, val, &v) == napi_ok) {
    napi_set_named_property(env, obj, key, v);
  }
}

static void set_double_prop(napi_env env, napi_value obj, const char* key, double val) {
  napi_value v = NULL;
  if (napi_create_double(env, val, &v) == napi_ok) {
    napi_set_named_property(env, obj, key, v);
  }
}

static void set_fn_prop(
    napi_env env, napi_value obj, const char* key, napi_callback cb, void* data) {
  napi_value fn = NULL;
  if (napi_create_function(env, key, NAPI_AUTO_LENGTH, cb, data, &fn) == napi_ok) {
    napi_set_named_property(env, obj, key, fn);
  }
}

static bool read_nonneg_safe_int(napi_env env, napi_value val, int64_t* out) {
  napi_valuetype t = napi_undefined;
  if (napi_typeof(env, val, &t) != napi_ok || t != napi_number) return false;
  double d = 0.0;
  if (napi_get_value_double(env, val, &d) != napi_ok) return false;
  if (!(d >= 0.0 && d <= 9007199254740991.0)) return false;
  int64_t iv = (int64_t)d;
  if ((double)iv != d) return false;
  *out = iv;
  return true;
}

static char* dup_named_str_prop(napi_env env, napi_value obj, const char* key, size_t max_len) {
  napi_valuetype ot = napi_undefined;
  if (napi_typeof(env, obj, &ot) != napi_ok || ot != napi_object) return NULL;
  napi_value prop = NULL;
  if (napi_get_named_property(env, obj, key, &prop) != napi_ok || !prop) return NULL;
  return dup_js_string(env, prop, max_len);
}

static bool parse_dec_i64(const char* s, int64_t* out) {
  if (!s || s[0] == '\0') return false;
  size_t i = 0;
  bool neg = false;
  if (s[0] == '-') {
    neg = true;
    i = 1;
    if (s[1] == '\0') return false;
  }
  uint64_t acc = 0;
  uint64_t limit = neg ? ((uint64_t)INT64_MAX + 1ULL) : (uint64_t)INT64_MAX;
  for (; s[i] != '\0'; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    uint64_t digit = (uint64_t)(s[i] - '0');
    if (acc > (limit - digit) / 10ULL) return false;
    acc = acc * 10ULL + digit;
  }
  if (neg) {
    if (acc == (uint64_t)INT64_MAX + 1ULL) {
      *out = INT64_MIN;
    } else {
      *out = -(int64_t)acc;
    }
  } else {
    *out = (int64_t)acc;
  }
  return true;
}

#if !defined(_WIN32)
static bool parse_dec_u64(const char* s, uint64_t* out) {
  if (!s || s[0] == '\0') return false;
  uint64_t acc = 0;
  for (size_t i = 0; s[i] != '\0'; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    uint64_t digit = (uint64_t)(s[i] - '0');
    if (acc > (UINT64_MAX - digit) / 10ULL) return false;
    acc = acc * 10ULL + digit;
  }
  *out = acc;
  return true;
}
#else
static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool parse_hex_u64(const char* s, uint64_t* out) {
  if (!s || strlen(s) != 16) return false;
  uint64_t acc = 0;
  for (size_t i = 0; i < 16; i++) {
    int n = hex_nibble(s[i]);
    if (n < 0) return false;
    acc = (acc << 4) | (uint64_t)n;
  }
  *out = acc;
  return true;
}

static bool parse_hex_bytes16(const char* s, uint8_t out[16]) {
  if (!s || strlen(s) != 32) return false;
  for (size_t i = 0; i < 16; i++) {
    int hi = hex_nibble(s[i * 2]);
    int lo = hex_nibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}
#endif

static napi_value create_publish_result(napi_env env, const char* status, const char* reason) {
  napi_value obj = NULL;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  set_str_prop(env, obj, "status", status);
  if (reason != NULL) {
    set_str_prop(env, obj, "reason", reason);
  }
  return obj;
}

static bool parse_segments_array(
    napi_env env,
    napi_value segs_arg,
    char* out_segs[AGY_MAX_PARENT_SEGMENTS],
    size_t* out_count) {
  *out_count = 0;
  bool is_arr = false;
  if (napi_is_array(env, segs_arg, &is_arr) != napi_ok || !is_arr) {
    napi_throw_type_error(env, "EINVAL", "parentSegments must be an array of strings.");
    return false;
  }
  uint32_t seg_count = 0;
  if (napi_get_array_length(env, segs_arg, &seg_count) != napi_ok ||
      seg_count > AGY_MAX_PARENT_SEGMENTS) {
    napi_throw_type_error(env, "EINVAL", "parentSegments exceeds maximum depth.");
    return false;
  }
  for (uint32_t i = 0; i < seg_count; i++) {
    napi_value el = NULL;
    if (napi_get_element(env, segs_arg, i, &el) != napi_ok) {
      for (size_t j = 0; j < *out_count; j++) free(out_segs[j]);
      *out_count = 0;
      napi_throw_type_error(env, "EINVAL", "Failed to read parentSegments element.");
      return false;
    }
    char* seg = dup_js_string(env, el, AGY_MAX_NAME_BYTES);
    if (!seg || !is_valid_segment(seg)) {
      free(seg);
      for (size_t j = 0; j < *out_count; j++) free(out_segs[j]);
      *out_count = 0;
      napi_throw_type_error(env, "EINVAL", "Each parent segment must be a safe single name.");
      return false;
    }
    out_segs[i] = seg;
    *out_count = (size_t)(i + 1);
  }
  return true;
}

/* ============================================================================
 * Platform File Identity & Locked View Implementation
 * ============================================================================ */

#if !defined(_WIN32)

typedef struct {
  uint64_t dev;
  uint64_t ino;
  int64_t size;
  int64_t mtime_ns;
  int64_t ctime_ns;
} AgyFileStat;

typedef struct {
  bool closed;
  bool shared_lock_held;
  bool db_slot_reserved;
  bool has_db_stat;
  bool track_wal;
  bool track_shm;
  bool track_journal;
  bool has_wal;
  bool has_shm;
  bool has_journal;
  char* root_dir;
  size_t segment_count;
  char* segments[AGY_MAX_PARENT_SEGMENTS];
  char* leaf_name;
  char* wal_name;
  char* shm_name;
  char* journal_name;
  int dir_fds[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  int db_fd;
  AgyFileStat db_stat;
  int wal_fd;
  AgyFileStat wal_stat;
  int shm_fd;
  AgyFileStat shm_stat;
} AgyLockedView;

static const char* errno_to_code(int err) {
  switch (err) {
    case ENOENT:
      return "ENOENT";
    case EACCES:
      return "EACCES";
    case EPERM:
      return "EPERM";
    case EAGAIN:
#if defined(EWOULDBLOCK) && EWOULDBLOCK != EAGAIN
    case EWOULDBLOCK:
#endif
    case EBUSY:
      return "EBUSY";
    case ELOOP:
      return "ELOOP";
    case ENOTDIR:
      return "ENOTDIR";
    case EISDIR:
      return "EISDIR";
    case EIO:
      return "EIO";
    case ENOSPC:
      return "ENOSPC";
#ifdef EDQUOT
    case EDQUOT:
      return "EDQUOT";
#endif
    case EROFS:
      return "EROFS";
    case EMFILE:
      return "EMFILE";
    case ENFILE:
      return "ENFILE";
    case ENOMEM:
      return "ENOMEM";
    case ENAMETOOLONG:
      return "ENAMETOOLONG";
    default:
      return "EINVAL";
  }
}

static AgyFileStat stat_to_agy(const struct stat* st) {
  AgyFileStat out;
  out.dev = (uint64_t)st->st_dev;
  out.ino = (uint64_t)st->st_ino;
  out.size = (int64_t)st->st_size;
#if defined(__APPLE__)
  out.mtime_ns = (int64_t)st->st_mtimespec.tv_sec * 1000000000LL + (int64_t)st->st_mtimespec.tv_nsec;
  out.ctime_ns = (int64_t)st->st_ctimespec.tv_sec * 1000000000LL + (int64_t)st->st_ctimespec.tv_nsec;
#else
  out.mtime_ns = (int64_t)st->st_mtim.tv_sec * 1000000000LL + (int64_t)st->st_mtim.tv_nsec;
  out.ctime_ns = (int64_t)st->st_ctim.tv_sec * 1000000000LL + (int64_t)st->st_ctim.tv_nsec;
#endif
  return out;
}

static bool file_stat_exact_match(const AgyFileStat* a, const AgyFileStat* b) {
  return a->dev == b->dev && a->ino == b->ino && a->size == b->size && a->mtime_ns == b->mtime_ns &&
         a->ctime_ns == b->ctime_ns;
}

static bool file_stat_inode_match(const AgyFileStat* a, const AgyFileStat* b) {
  return a->dev == b->dev && a->ino == b->ino;
}

static napi_value create_identity_object(napi_env env, const AgyFileStat* st) {
  napi_value obj = NULL;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  char buf[64];
  snprintf(buf, sizeof(buf), "%llu", (unsigned long long)st->dev);
  set_str_prop(env, obj, "dev", buf);
  snprintf(buf, sizeof(buf), "%llu", (unsigned long long)st->ino);
  set_str_prop(env, obj, "ino", buf);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->size);
  set_str_prop(env, obj, "size", buf);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->mtime_ns);
  set_str_prop(env, obj, "mtimeNs", buf);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->ctime_ns);
  set_str_prop(env, obj, "ctimeNs", buf);
  return obj;
}

static bool parse_identity_arg(napi_env env, napi_value obj, AgyFileStat* out) {
  char* dev_s = dup_named_str_prop(env, obj, "dev", 64);
  char* ino_s = dup_named_str_prop(env, obj, "ino", 64);
  char* size_s = dup_named_str_prop(env, obj, "size", 64);
  char* mtime_s = dup_named_str_prop(env, obj, "mtimeNs", 64);
  char* ctime_s = dup_named_str_prop(env, obj, "ctimeNs", 64);
  bool ok = dev_s && ino_s && size_s && mtime_s && ctime_s && parse_dec_u64(dev_s, &out->dev) &&
            parse_dec_u64(ino_s, &out->ino) && parse_dec_i64(size_s, &out->size) &&
            parse_dec_i64(mtime_s, &out->mtime_ns) && parse_dec_i64(ctime_s, &out->ctime_ns);
  free(dev_s);
  free(ino_s);
  free(size_s);
  free(mtime_s);
  free(ctime_s);
  return ok;
}

#define AGY_MAX_DEFERRED_FDS_PER_INODE 64

typedef enum {
  AGY_LOCK_NONE = 0,
  AGY_LOCK_SHARED = 1,
  AGY_LOCK_EXCLUSIVE = 2
} AgyLockKind;

typedef struct AgyInodeLockEntry {
  uint64_t dev;
  uint64_t ino;
  size_t shared_refs;
  bool exclusive_held;
  size_t reserved_close_slots;
  size_t deferred_count;
  int deferred_fds[AGY_MAX_DEFERRED_FDS_PER_INODE];
  struct AgyInodeLockEntry* next;
} AgyInodeLockEntry;

static pthread_mutex_t g_inode_lock_mu = PTHREAD_MUTEX_INITIALIZER;
static AgyInodeLockEntry* g_inode_locks = NULL;

static AgyInodeLockEntry* find_inode_lock_entry_locked(uint64_t dev, uint64_t ino) {
  for (AgyInodeLockEntry* cur = g_inode_locks; cur != NULL; cur = cur->next) {
    if (cur->dev == dev && cur->ino == ino) return cur;
  }
  return NULL;
}

static bool posix_inode_is_locked(uint64_t dev, uint64_t ino) {
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry* entry = find_inode_lock_entry_locked(dev, ino);
  bool locked = entry != NULL && (entry->shared_refs > 0 || entry->exclusive_held);
  pthread_mutex_unlock(&g_inode_lock_mu);
  return locked;
}

static int acquire_sqlite_shared_lock(int fd) {
  struct flock fl;
  memset(&fl, 0, sizeof(fl));
  fl.l_type = F_RDLCK;
  fl.l_whence = SEEK_SET;
  fl.l_start = (off_t)SQLITE_PENDING_BYTE;
  fl.l_len = 1;
  while (fcntl(fd, F_SETLK, &fl) == -1) {
    if (errno == EINTR) continue;
    return errno;
  }

  fl.l_type = F_RDLCK;
  fl.l_start = (off_t)SQLITE_SHARED_FIRST;
  fl.l_len = (off_t)SQLITE_SHARED_SIZE;
  while (fcntl(fd, F_SETLK, &fl) == -1) {
    if (errno == EINTR) continue;
    int saved = errno;
    fl.l_type = F_UNLCK;
    fl.l_start = (off_t)SQLITE_PENDING_BYTE;
    fl.l_len = 1;
    (void)fcntl(fd, F_SETLK, &fl);
    return saved;
  }

  fl.l_type = F_UNLCK;
  fl.l_start = (off_t)SQLITE_PENDING_BYTE;
  fl.l_len = 1;
  while (fcntl(fd, F_SETLK, &fl) == -1) {
    if (errno == EINTR) continue;
    break;
  }
  return 0;
}

static void release_sqlite_lock(int fd) {
  struct flock fl;
  memset(&fl, 0, sizeof(fl));
  fl.l_type = F_UNLCK;
  fl.l_whence = SEEK_SET;
  fl.l_start = (off_t)SQLITE_PENDING_BYTE;
  fl.l_len = (off_t)SQLITE_LOCK_SPAN;
  (void)fcntl(fd, F_SETLK, &fl);
}

static int posix_reserve_fd_slot(
    uint64_t dev, uint64_t ino, bool require_exclusive_free, bool require_all_locks_free) {
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry* entry = find_inode_lock_entry_locked(dev, ino);
  if (entry != NULL) {
    if (require_all_locks_free && (entry->shared_refs > 0 || entry->exclusive_held)) {
      pthread_mutex_unlock(&g_inode_lock_mu);
      return EBUSY;
    }
    if (require_exclusive_free && entry->exclusive_held) {
      pthread_mutex_unlock(&g_inode_lock_mu);
      return EBUSY;
    }
    if (entry->deferred_count + entry->reserved_close_slots >= AGY_MAX_DEFERRED_FDS_PER_INODE) {
      pthread_mutex_unlock(&g_inode_lock_mu);
      return EMFILE;
    }
    entry->reserved_close_slots += 1;
    pthread_mutex_unlock(&g_inode_lock_mu);
    return 0;
  }
  entry = (AgyInodeLockEntry*)calloc(1, sizeof(AgyInodeLockEntry));
  if (!entry) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return ENOMEM;
  }
  entry->dev = dev;
  entry->ino = ino;
  entry->reserved_close_slots = 1;
  entry->next = g_inode_locks;
  g_inode_locks = entry;
  pthread_mutex_unlock(&g_inode_lock_mu);
  return 0;
}

static int posix_check_or_reserve_probe_slot(
    uint64_t dev, uint64_t ino, bool* out_already_locked) {
  *out_already_locked = false;
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry* entry = find_inode_lock_entry_locked(dev, ino);
  if (entry != NULL && (entry->shared_refs > 0 || entry->exclusive_held)) {
    *out_already_locked = true;
    pthread_mutex_unlock(&g_inode_lock_mu);
    return 0;
  }
  if (entry != NULL) {
    if (entry->deferred_count + entry->reserved_close_slots >= AGY_MAX_DEFERRED_FDS_PER_INODE) {
      pthread_mutex_unlock(&g_inode_lock_mu);
      return EMFILE;
    }
    entry->reserved_close_slots += 1;
    pthread_mutex_unlock(&g_inode_lock_mu);
    return 0;
  }
  entry = (AgyInodeLockEntry*)calloc(1, sizeof(AgyInodeLockEntry));
  if (!entry) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return ENOMEM;
  }
  entry->dev = dev;
  entry->ino = ino;
  entry->reserved_close_slots = 1;
  entry->next = g_inode_locks;
  g_inode_locks = entry;
  pthread_mutex_unlock(&g_inode_lock_mu);
  return 0;
}

static void posix_unreserve_fd_slot(uint64_t dev, uint64_t ino) {
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry** prev = &g_inode_locks;
  AgyInodeLockEntry* entry = g_inode_locks;
  while (entry != NULL && !(entry->dev == dev && entry->ino == ino)) {
    prev = &entry->next;
    entry = entry->next;
  }
  if (entry != NULL) {
    if (entry->reserved_close_slots > 0) {
      entry->reserved_close_slots -= 1;
    }
    if (entry->shared_refs == 0 && !entry->exclusive_held) {
      for (size_t i = 0; i < entry->deferred_count; i++) {
        if (entry->deferred_fds[i] >= 0) close(entry->deferred_fds[i]);
      }
      entry->deferred_count = 0;
      if (entry->reserved_close_slots == 0) {
        *prev = entry->next;
        free(entry);
      }
    }
  }
  pthread_mutex_unlock(&g_inode_lock_mu);
}

static int posix_acquire_shared_lock(int fd, uint64_t dev, uint64_t ino) {
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry* entry = find_inode_lock_entry_locked(dev, ino);
  if (!entry) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return EINVAL;
  }
  if (entry->exclusive_held) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return EBUSY;
  }
  if (entry->shared_refs > 0) {
    entry->shared_refs += 1;
    pthread_mutex_unlock(&g_inode_lock_mu);
    return 0;
  }
  int lock_err = acquire_sqlite_shared_lock(fd);
  if (lock_err != 0) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return lock_err;
  }
  entry->shared_refs = 1;
  pthread_mutex_unlock(&g_inode_lock_mu);
  return 0;
}

static int posix_acquire_exclusive_lock(int fd, uint64_t dev, uint64_t ino) {
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry* entry = find_inode_lock_entry_locked(dev, ino);
  if (!entry) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return EINVAL;
  }
  if (entry->shared_refs > 0 || entry->exclusive_held) {
    pthread_mutex_unlock(&g_inode_lock_mu);
    return EBUSY;
  }
  struct flock fl;
  memset(&fl, 0, sizeof(fl));
  fl.l_type = F_WRLCK;
  fl.l_whence = SEEK_SET;
  fl.l_start = (off_t)SQLITE_PENDING_BYTE;
  fl.l_len = (off_t)SQLITE_LOCK_SPAN;
  while (fcntl(fd, F_SETLK, &fl) == -1) {
    if (errno == EINTR) continue;
    int saved = errno;
    pthread_mutex_unlock(&g_inode_lock_mu);
    return saved;
  }
  entry->exclusive_held = true;
  pthread_mutex_unlock(&g_inode_lock_mu);
  return 0;
}

static void posix_release_fd(
    int fd, uint64_t dev, uint64_t ino, AgyLockKind lock_kind, bool had_reserved_slot) {
  if (fd < 0) {
    if (had_reserved_slot) posix_unreserve_fd_slot(dev, ino);
    return;
  }
  pthread_mutex_lock(&g_inode_lock_mu);
  AgyInodeLockEntry** prev = &g_inode_locks;
  AgyInodeLockEntry* entry = g_inode_locks;
  while (entry != NULL && !(entry->dev == dev && entry->ino == ino)) {
    prev = &entry->next;
    entry = entry->next;
  }
  if (entry != NULL) {
    if (lock_kind == AGY_LOCK_SHARED && entry->shared_refs > 0) {
      entry->shared_refs -= 1;
    } else if (lock_kind == AGY_LOCK_EXCLUSIVE) {
      entry->exclusive_held = false;
    }
    if (had_reserved_slot && entry->reserved_close_slots > 0) {
      entry->reserved_close_slots -= 1;
    }
    if (entry->shared_refs > 0 || entry->exclusive_held) {
      /* Another live holder in this PID holds a POSIX fcntl lock on (dev, ino).
       * Defer closing this fd into its pre-reserved inline slot (allocation-free). */
      if (entry->deferred_count < AGY_MAX_DEFERRED_FDS_PER_INODE) {
        entry->deferred_fds[entry->deferred_count++] = fd;
      }
      pthread_mutex_unlock(&g_inode_lock_mu);
      return;
    }
  }
  if (lock_kind != AGY_LOCK_NONE) {
    release_sqlite_lock(fd);
  }
  close(fd);
  if (entry != NULL) {
    for (size_t i = 0; i < entry->deferred_count; i++) {
      if (entry->deferred_fds[i] >= 0) close(entry->deferred_fds[i]);
    }
    entry->deferred_count = 0;
    if (entry->reserved_close_slots == 0 && entry->shared_refs == 0 && !entry->exclusive_held) {
      *prev = entry->next;
      free(entry);
    }
  }
  pthread_mutex_unlock(&g_inode_lock_mu);
}

static void view_close_handles(AgyLockedView* v) {
  if (!v || v->closed) return;
  v->closed = true;
  if (v->shm_fd >= 0) {
    close(v->shm_fd);
    v->shm_fd = -1;
  }
  if (v->wal_fd >= 0) {
    close(v->wal_fd);
    v->wal_fd = -1;
  }
  if (v->db_fd >= 0 || v->db_slot_reserved) {
    int fd = v->db_fd;
    bool held = v->shared_lock_held;
    bool reserved = v->db_slot_reserved;
    v->db_fd = -1;
    v->shared_lock_held = false;
    v->db_slot_reserved = false;
    if (v->has_db_stat) {
      posix_release_fd(
          fd, v->db_stat.dev, v->db_stat.ino, held ? AGY_LOCK_SHARED : AGY_LOCK_NONE, reserved);
    } else if (fd >= 0) {
      if (held) release_sqlite_lock(fd);
      close(fd);
    }
  }
  for (size_t i = 0; i <= v->segment_count; i++) {
    if (v->dir_fds[i] >= 0) {
      close(v->dir_fds[i]);
      v->dir_fds[i] = -1;
    }
  }
}

static void view_destroy(AgyLockedView* v) {
  if (!v) return;
  view_close_handles(v);
  free(v->root_dir);
  for (size_t i = 0; i < v->segment_count; i++) {
    free(v->segments[i]);
  }
  free(v->leaf_name);
  free(v->wal_name);
  free(v->shm_name);
  free(v->journal_name);
  free(v);
}

static napi_value view_read_fd(napi_env env, int fd, int64_t offset, int64_t length) {
  if (offset < 0 || length < 0 || length > AGY_MAX_READ_BYTES) {
    return throw_coded_error(env, "EINVAL", "read", "Invalid offset or length for native readAt.");
  }
  void* raw = NULL;
  napi_value buf = NULL;
  if (napi_create_buffer(env, (size_t)length, &raw, &buf) != napi_ok) {
    return throw_coded_error(env, "ENOMEM", "read", "Failed to allocate read buffer.");
  }
  if (length == 0) return buf;
  uint8_t* dst = (uint8_t*)raw;
  int64_t done = 0;
  while (done < length) {
    ssize_t n = pread(fd, dst + done, (size_t)(length - done), (off_t)(offset + done));
    if (n < 0) {
      if (errno == EINTR) continue;
      return throw_coded_error(env, errno_to_code(errno), "read", "Native pread failed.");
    }
    if (n == 0) {
      return throw_coded_error(
          env, "ERR_UNEXPECTED_EOF", "read", "Unexpected EOF during native pread.");
    }
    done += (int64_t)n;
  }
  return buf;
}

static const char* view_verify_unchanged_impl(AgyLockedView* v) {
  if (!v || v->closed || v->db_fd < 0) return "closed";
  int parent_fd = v->dir_fds[v->segment_count];
  if (parent_fd < 0) return "closed";

  /* 1. Verify rootDir and every anchored parent segment without opening/closing any DB fd. */
  struct stat st;
  if (lstat(v->root_dir, &st) != 0) return "root_changed";
  if (!S_ISDIR(st.st_mode)) return "root_changed";
  AgyFileStat cur_root = stat_to_agy(&st);
  if (!file_stat_inode_match(&v->dir_stats[0], &cur_root)) return "root_changed";

  for (size_t i = 0; i < v->segment_count; i++) {
    if (fstatat(v->dir_fds[i], v->segments[i], &st, AT_SYMLINK_NOFOLLOW) != 0) {
      return "parent_changed";
    }
    if (!S_ISDIR(st.st_mode)) return "parent_changed";
    AgyFileStat cur_seg = stat_to_agy(&st);
    if (!file_stat_inode_match(&v->dir_stats[i + 1], &cur_seg)) return "parent_changed";
    if (fstat(v->dir_fds[i + 1], &st) != 0) return "parent_changed";
    AgyFileStat cur_fd_seg = stat_to_agy(&st);
    if (!file_stat_inode_match(&v->dir_stats[i + 1], &cur_fd_seg)) return "parent_changed";
  }

  /* 2. Verify pinned main DB handle and its anchored directory entry. */
  if (fstat(v->db_fd, &st) != 0) return "db_stat_failed";
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "db_linked_or_invalid";
  AgyFileStat cur_db = stat_to_agy(&st);
  if (!file_stat_exact_match(&v->db_stat, &cur_db)) return "db_changed";

  if (fstatat(parent_fd, v->leaf_name, &st, AT_SYMLINK_NOFOLLOW) != 0) return "db_path_changed";
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "db_path_changed";
  AgyFileStat path_db = stat_to_agy(&st);
  if (!file_stat_exact_match(&v->db_stat, &path_db)) return "db_path_changed";

  /* 3. Verify rollback journal presence did not change. */
  if (v->track_journal) {
    if (fstatat(parent_fd, v->journal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!v->has_journal) return "journal_appeared";
    } else if (errno != ENOENT) {
      return "journal_stat_failed";
    }
  }

  /* 4. Verify WAL identity/absence. */
  if (v->track_wal) {
    if (!v->has_wal) {
      if (fstatat(parent_fd, v->wal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) return "wal_appeared";
      if (errno != ENOENT) return "wal_stat_failed";
    } else {
      if (v->wal_fd < 0 || fstat(v->wal_fd, &st) != 0) return "wal_changed";
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "wal_changed";
      AgyFileStat cur_wal = stat_to_agy(&st);
      if (!file_stat_exact_match(&v->wal_stat, &cur_wal)) return "wal_changed";

      if (fstatat(parent_fd, v->wal_name, &st, AT_SYMLINK_NOFOLLOW) != 0) return "wal_changed";
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "wal_changed";
      AgyFileStat path_wal = stat_to_agy(&st);
      if (!file_stat_exact_match(&v->wal_stat, &path_wal)) return "wal_changed";
    }
  }

  /* 5. Verify SHM inode identity/absence (header bytes are checked by caller via readShmAt). */
  if (v->track_shm) {
    if (!v->has_shm) {
      if (fstatat(parent_fd, v->shm_name, &st, AT_SYMLINK_NOFOLLOW) == 0) return "shm_appeared";
      if (errno != ENOENT) return "shm_stat_failed";
    } else {
      if (v->shm_fd < 0 || fstat(v->shm_fd, &st) != 0) return "shm_changed";
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "shm_changed";
      AgyFileStat cur_shm = stat_to_agy(&st);
      if (!file_stat_inode_match(&v->shm_stat, &cur_shm)) return "shm_changed";

      if (fstatat(parent_fd, v->shm_name, &st, AT_SYMLINK_NOFOLLOW) != 0) return "shm_changed";
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) return "shm_changed";
      AgyFileStat path_shm = stat_to_agy(&st);
      if (!file_stat_inode_match(&v->shm_stat, &path_shm)) return "shm_changed";
    }
  }

  return NULL;
}

static int open_dir_chain_posix(
    const char* root_dir,
    char* const* segments,
    size_t segment_count,
    int dir_fds[AGY_MAX_PARENT_SEGMENTS + 1],
    AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1],
    const char** err_code,
    const char** err_stage,
    const char** err_msg) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) dir_fds[i] = -1;
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int root_fd = open(root_dir, flags);
  if (root_fd < 0) {
    *err_code = errno_to_code(errno);
    *err_stage = "root";
    *err_msg = "Failed to open anchored storage root directory.";
    return -1;
  }
  struct stat st;
  if (fstat(root_fd, &st) != 0) {
    int e = errno;
    close(root_fd);
    *err_code = errno_to_code(e);
    *err_stage = "root";
    *err_msg = "Failed to stat anchored storage root directory.";
    return -1;
  }
  if (!S_ISDIR(st.st_mode)) {
    close(root_fd);
    *err_code = "ENOTDIR";
    *err_stage = "root";
    *err_msg = "Storage root is not an ordinary directory.";
    return -1;
  }
  dir_fds[0] = root_fd;
  dir_stats[0] = stat_to_agy(&st);

  for (size_t i = 0; i < segment_count; i++) {
    int next_fd = openat(dir_fds[i], segments[i], flags);
    if (next_fd < 0) {
      *err_code = errno_to_code(errno);
      *err_stage = "parent";
      *err_msg = "Failed to open anchored parent directory segment.";
      return -1;
    }
    if (fstat(next_fd, &st) != 0) {
      int e = errno;
      close(next_fd);
      *err_code = errno_to_code(e);
      *err_stage = "parent";
      *err_msg = "Failed to stat anchored parent directory segment.";
      return -1;
    }
    if (!S_ISDIR(st.st_mode)) {
      close(next_fd);
      *err_code = "ENOTDIR";
      *err_stage = "parent";
      *err_msg = "Parent segment is not an ordinary directory.";
      return -1;
    }
    dir_fds[i + 1] = next_fd;
    dir_stats[i + 1] = stat_to_agy(&st);
  }
  return 0;
}

static void close_dir_chain_posix(int dir_fds[AGY_MAX_PARENT_SEGMENTS + 1], size_t segment_count) {
  for (size_t i = 0; i <= segment_count; i++) {
    if (dir_fds[i] >= 0) {
      close(dir_fds[i]);
      dir_fds[i] = -1;
    }
  }
}

static bool verify_dir_chain_posix(
    const char* root_dir,
    char* const* segments,
    size_t segment_count,
    const int dir_fds[AGY_MAX_PARENT_SEGMENTS + 1],
    const AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1]) {
  struct stat st;
  if (lstat(root_dir, &st) != 0 || !S_ISDIR(st.st_mode)) return false;
  AgyFileStat cur_root = stat_to_agy(&st);
  if (!file_stat_inode_match(&dir_stats[0], &cur_root)) return false;
  for (size_t i = 0; i < segment_count; i++) {
    if (fstatat(dir_fds[i], segments[i], &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(st.st_mode)) {
      return false;
    }
    AgyFileStat cur_seg = stat_to_agy(&st);
    if (!file_stat_inode_match(&dir_stats[i + 1], &cur_seg)) return false;
    if (fstat(dir_fds[i + 1], &st) != 0 || !S_ISDIR(st.st_mode)) return false;
    AgyFileStat cur_fd_seg = stat_to_agy(&st);
    if (!file_stat_inode_match(&dir_stats[i + 1], &cur_fd_seg)) return false;
  }
  return true;
}

static int open_anchored_dirs_posix(
    AgyLockedView* v, const char** err_code, const char** err_stage, const char** err_msg) {
  return open_dir_chain_posix(
      v->root_dir, v->segments, v->segment_count, v->dir_fds, v->dir_stats, err_code, err_stage,
      err_msg);
}

static bool open_anchored_view_platform(
    napi_env env,
    AgyLockedView* v,
    bool acquire_lock,
    bool open_wal,
    bool open_shm,
    bool check_journal) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) v->dir_fds[i] = -1;
  v->db_fd = -1;
  v->wal_fd = -1;
  v->shm_fd = -1;
  v->track_wal = open_wal;
  v->track_shm = open_shm;
  v->track_journal = check_journal;

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored SQLite view.";
  if (open_anchored_dirs_posix(v, &err_code, &err_stage, &err_msg) != 0) {
    view_destroy(v);
    throw_coded_error(env, err_code, err_stage, err_msg);
    return false;
  }

  int parent_fd = v->dir_fds[v->segment_count];
  struct stat st;
  if (check_journal) {
    if (fstatat(parent_fd, v->journal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
      v->has_journal = true;
    } else if (errno != ENOENT) {
      int e = errno;
      view_destroy(v);
      throw_coded_error(
          env, errno_to_code(e), "journal", "Failed to inspect rollback journal.");
      return false;
    }
  }

  int file_flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
#ifdef O_CLOEXEC
  file_flags |= O_CLOEXEC;
#endif
  if (fstatat(parent_fd, v->leaf_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    int e = errno;
    view_destroy(v);
    throw_coded_error(
        env, errno_to_code(e), "leaf", "Failed to open anchored SQLite database file.");
    return false;
  }
  if (S_ISLNK(st.st_mode)) {
    view_destroy(v);
    throw_coded_error(
        env, "ELOOP", "leaf", "SQLite database must not be a symbolic link.");
    return false;
  }
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
    view_destroy(v);
    throw_coded_error(
        env, "ELINK", "leaf", "SQLite database must be one ordinary single-link regular file.");
    return false;
  }
  AgyFileStat pre_db_stat = stat_to_agy(&st);
  int slot_err = posix_reserve_fd_slot(pre_db_stat.dev, pre_db_stat.ino, acquire_lock, false);
  if (slot_err != 0) {
    view_destroy(v);
    throw_coded_error(
        env,
        (slot_err == EACCES || slot_err == EAGAIN || slot_err == EBUSY)
            ? "EBUSY"
            : errno_to_code(slot_err),
        "lock",
        "Unable to reserve SQLite database descriptor slot.");
    return false;
  }
  v->db_stat = pre_db_stat;
  v->has_db_stat = true;
  v->db_slot_reserved = true;

  int db_fd = openat(parent_fd, v->leaf_name, file_flags);
  if (db_fd < 0) {
    int e = errno;
    view_destroy(v);
    throw_coded_error(
        env, errno_to_code(e), "leaf", "Failed to open anchored SQLite database file.");
    return false;
  }
  if (fstat(db_fd, &st) != 0) {
    int e = errno;
    posix_release_fd(db_fd, pre_db_stat.dev, pre_db_stat.ino, AGY_LOCK_NONE, true);
    v->db_slot_reserved = false;
    view_destroy(v);
    throw_coded_error(env, errno_to_code(e), "leaf", "Failed to stat opened SQLite file.");
    return false;
  }
  AgyFileStat post_db_stat = stat_to_agy(&st);
  if (!file_stat_inode_match(&pre_db_stat, &post_db_stat)) {
    posix_unreserve_fd_slot(pre_db_stat.dev, pre_db_stat.ino);
    v->db_slot_reserved = false;
    int re_slot = posix_reserve_fd_slot(post_db_stat.dev, post_db_stat.ino, acquire_lock, false);
    if (re_slot != 0) {
      posix_release_fd(db_fd, post_db_stat.dev, post_db_stat.ino, AGY_LOCK_NONE, false);
      view_destroy(v);
      throw_coded_error(
          env, "EBUSY", "leaf", "SQLite database inode changed during anchored open.");
      return false;
    }
    v->db_slot_reserved = true;
  }
  v->db_fd = db_fd;
  v->db_stat = post_db_stat;
  v->has_db_stat = true;
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
    view_destroy(v);
    throw_coded_error(
        env, "ELINK", "leaf", "SQLite database must be one ordinary single-link regular file.");
    return false;
  }

  if (acquire_lock) {
    int lock_err = posix_acquire_shared_lock(db_fd, v->db_stat.dev, v->db_stat.ino);
    if (lock_err != 0) {
      view_destroy(v);
      throw_coded_error(
          env,
          (lock_err == EACCES || lock_err == EAGAIN || lock_err == EBUSY)
              ? "EBUSY"
              : errno_to_code(lock_err),
          "lock",
          "SQLite database is locked by an active writer.");
      return false;
    }
    v->shared_lock_held = true;
  }

  if (open_wal) {
    int wfd = openat(parent_fd, v->wal_name, file_flags);
    if (wfd >= 0) {
      v->wal_fd = wfd;
      if (fstat(wfd, &st) != 0) {
        int e = errno;
        view_destroy(v);
        throw_coded_error(env, errno_to_code(e), "wal", "Failed to stat anchored WAL file.");
        return false;
      }
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
        view_destroy(v);
        throw_coded_error(
            env, "ELINK", "wal", "SQLite WAL sidefile must be one ordinary single-link file.");
        return false;
      }
      v->wal_stat = stat_to_agy(&st);
      v->has_wal = true;
    } else if (errno != ENOENT) {
      int e = errno;
      view_destroy(v);
      throw_coded_error(env, errno_to_code(e), "wal", "Failed to open anchored WAL file.");
      return false;
    }
  }

  if (open_shm) {
    int sfd = openat(parent_fd, v->shm_name, file_flags);
    if (sfd >= 0) {
      v->shm_fd = sfd;
      if (fstat(sfd, &st) != 0) {
        int e = errno;
        view_destroy(v);
        throw_coded_error(env, errno_to_code(e), "shm", "Failed to stat anchored SHM file.");
        return false;
      }
      if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
        view_destroy(v);
        throw_coded_error(
            env, "ELINK", "shm", "SQLite SHM sidefile must be one ordinary single-link file.");
        return false;
      }
      v->shm_stat = stat_to_agy(&st);
      v->has_shm = true;
    } else if (errno != ENOENT) {
      int e = errno;
      view_destroy(v);
      throw_coded_error(env, errno_to_code(e), "shm", "Failed to open anchored SHM file.");
      return false;
    }
  }

  if (check_journal && !v->has_journal) {
    if (fstatat(parent_fd, v->journal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
      v->has_journal = true;
    } else if (errno != ENOENT) {
      int e = errno;
      view_destroy(v);
      throw_coded_error(
          env, errno_to_code(e), "journal", "Failed to re-check rollback journal.");
      return false;
    }
  }

  return true;
}

static napi_value verify_candidate_platform(napi_env env, AgyLockedView* v) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) v->dir_fds[i] = -1;
  v->db_fd = -1;
  v->wal_fd = -1;
  v->shm_fd = -1;

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to inspect candidate SQLite file.";
  if (open_anchored_dirs_posix(v, &err_code, &err_stage, &err_msg) != 0) {
    view_destroy(v);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  int parent_fd = v->dir_fds[v->segment_count];
  int file_flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
#ifdef O_CLOEXEC
  file_flags |= O_CLOEXEC;
#endif
  struct stat st;
  if (fstatat(parent_fd, v->leaf_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    int e = errno;
    view_destroy(v);
    return throw_coded_error(
        env, errno_to_code(e), "leaf", "Failed to open candidate SQLite database.");
  }
  if (S_ISLNK(st.st_mode)) {
    view_destroy(v);
    return throw_coded_error(
        env, "ELOOP", "leaf", "Candidate database must not be a symbolic link.");
  }
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
    view_destroy(v);
    return throw_coded_error(
        env, "ELINK", "leaf", "Candidate database must be one ordinary single-link file.");
  }
  AgyFileStat db_stat = stat_to_agy(&st);
  bool already_locked_in_pid = false;
  int probe_slot_err =
      posix_check_or_reserve_probe_slot(db_stat.dev, db_stat.ino, &already_locked_in_pid);
  if (probe_slot_err != 0) {
    view_destroy(v);
    return throw_coded_error(
        env,
        errno_to_code(probe_slot_err),
        "lock",
        "Failed to reserve descriptor slot for candidate lock probe.");
  }

  bool has_active_lock = already_locked_in_pid;
  if (!already_locked_in_pid) {
    v->db_stat = db_stat;
    v->has_db_stat = true;
    v->db_slot_reserved = true;

    int db_fd = openat(parent_fd, v->leaf_name, file_flags);
    if (db_fd < 0) {
      int e = errno;
      view_destroy(v);
      return throw_coded_error(
          env, errno_to_code(e), "leaf", "Failed to open candidate SQLite database.");
    }
    if (fstat(db_fd, &st) != 0) {
      int e = errno;
      posix_release_fd(db_fd, db_stat.dev, db_stat.ino, AGY_LOCK_NONE, true);
      v->db_slot_reserved = false;
      view_destroy(v);
      return throw_coded_error(
          env, errno_to_code(e), "leaf", "Failed to stat candidate SQLite database.");
    }
    AgyFileStat post_stat = stat_to_agy(&st);
    if (!file_stat_inode_match(&db_stat, &post_stat)) {
      posix_unreserve_fd_slot(db_stat.dev, db_stat.ino);
      v->db_slot_reserved = false;
      int re_slot = posix_reserve_fd_slot(post_stat.dev, post_stat.ino, false, false);
      if (re_slot != 0) {
        posix_release_fd(db_fd, post_stat.dev, post_stat.ino, AGY_LOCK_NONE, false);
        view_destroy(v);
        return throw_coded_error(
            env, "EBUSY", "leaf", "Candidate database inode changed during lock probe.");
      }
      v->db_slot_reserved = true;
    }
    db_stat = post_stat;
    v->db_fd = db_fd;
    v->db_stat = db_stat;
    v->has_db_stat = true;
    if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
      view_destroy(v);
      return throw_coded_error(
          env, "ELINK", "leaf", "Candidate database must be one ordinary single-link file.");
    }

    /* Probe whether this PID or ANY other PID holds ANY SQLite lock. */
    has_active_lock = posix_inode_is_locked(db_stat.dev, db_stat.ino);
    if (!has_active_lock) {
      struct flock fl;
      memset(&fl, 0, sizeof(fl));
      fl.l_type = F_WRLCK;
      fl.l_whence = SEEK_SET;
      fl.l_start = (off_t)SQLITE_PENDING_BYTE;
      fl.l_len = (off_t)SQLITE_LOCK_SPAN;
      if (fcntl(db_fd, F_GETLK, &fl) != 0) {
        int e = errno;
        view_destroy(v);
        return throw_coded_error(
            env, errno_to_code(e), "lock", "Failed to probe SQLite locks on candidate database.");
      }
      if (fl.l_type != F_UNLCK) {
        has_active_lock = true;
      }
    }
  }

  bool has_journal = false;
  if (fstatat(parent_fd, v->journal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
    has_journal = true;
  } else if (errno != ENOENT) {
    int e = errno;
    view_destroy(v);
    return throw_coded_error(
        env, errno_to_code(e), "journal", "Failed to inspect candidate journal.");
  }

  bool has_wal = false;
  int64_t wal_bytes = 0;
  if (fstatat(parent_fd, v->wal_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
      view_destroy(v);
      return throw_coded_error(
          env, "ELINK", "wal", "Candidate WAL sidefile must be one ordinary single-link file.");
    }
    has_wal = true;
    wal_bytes = (int64_t)st.st_size;
  } else if (errno != ENOENT) {
    int e = errno;
    view_destroy(v);
    return throw_coded_error(env, errno_to_code(e), "wal", "Failed to inspect candidate WAL.");
  }

  bool has_shm = false;
  if (fstatat(parent_fd, v->shm_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(st.st_mode) || st.st_nlink != 1) {
      view_destroy(v);
      return throw_coded_error(
          env, "ELINK", "shm", "Candidate SHM sidefile must be one ordinary single-link file.");
    }
    has_shm = true;
  } else if (errno != ENOENT) {
    int e = errno;
    view_destroy(v);
    return throw_coded_error(env, errno_to_code(e), "shm", "Failed to inspect candidate SHM.");
  }

  view_destroy(v);

  napi_value out = NULL;
  if (napi_create_object(env, &out) != napi_ok) return NULL;
  set_double_prop(env, out, "byteLength", (double)db_stat.size);
  set_bool_prop(env, out, "hasActiveLock", has_active_lock);
  set_bool_prop(env, out, "hasJournal", has_journal);
  set_bool_prop(env, out, "hasWal", has_wal);
  set_double_prop(env, out, "walByteLength", (double)wal_bytes);
  set_bool_prop(env, out, "hasShm", has_shm);
  napi_value id_obj = create_identity_object(env, &db_stat);
  if (id_obj) napi_set_named_property(env, out, "fileIdentity", id_obj);
  return out;
}

static napi_value check_same_volume_platform(
    napi_env env,
    const char* root_dir,
    char* const* left_segs,
    size_t left_count,
    char* const* right_segs,
    size_t right_count) {
  int left_fds[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat left_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  int right_fds[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat right_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored directories for volume check.";

  if (open_dir_chain_posix(
          root_dir, left_segs, left_count, left_fds, left_stats, &err_code, &err_stage, &err_msg) !=
      0) {
    close_dir_chain_posix(left_fds, left_count);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  if (open_dir_chain_posix(
          root_dir, right_segs, right_count, right_fds, right_stats, &err_code, &err_stage,
          &err_msg) != 0) {
    close_dir_chain_posix(left_fds, left_count);
    close_dir_chain_posix(right_fds, right_count);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  bool same = left_stats[left_count].dev == right_stats[right_count].dev;
  close_dir_chain_posix(left_fds, left_count);
  close_dir_chain_posix(right_fds, right_count);
  napi_value out = NULL;
  if (napi_get_boolean(env, same, &out) != napi_ok) return NULL;
  return out;
}

static napi_value publish_candidate_atomically_platform(
    napi_env env,
    const char* root_dir,
    char* const* target_segs,
    size_t target_seg_count,
    const char* target_leaf,
    char* const* staged_segs,
    size_t staged_seg_count,
    const char* staged_leaf,
    const AgyFileStat* expected_target,
    const AgyFileStat* expected_staged) {
  int target_fds[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat target_dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  int staged_fds[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat staged_dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    target_fds[i] = -1;
    staged_fds[i] = -1;
  }

  int staged_fd = -1;
  int target_fd = -1;
  int wal_fd = -1;
  int shm_fd = -1;
  bool has_staged_stat = false;
  bool has_target_stat = false;
  bool staged_slot_reserved = false;
  bool target_slot_reserved = false;
  bool staged_locked = false;
  bool target_locked = false;
  AgyFileStat staged_stat;
  AgyFileStat target_stat;
  AgyFileStat wal_stat;
  AgyFileStat shm_stat;
  memset(&staged_stat, 0, sizeof(staged_stat));
  memset(&target_stat, 0, sizeof(target_stat));
  memset(&wal_stat, 0, sizeof(wal_stat));
  memset(&shm_stat, 0, sizeof(shm_stat));

  char* target_wal = concat_suffix(target_leaf, "-wal");
  char* target_shm = concat_suffix(target_leaf, "-shm");
  char* target_journal = concat_suffix(target_leaf, "-journal");

  const char* res_status = "uncertain";
  const char* res_reason = "internal_error";

  if (!target_wal || !target_shm || !target_journal) {
    res_reason = "oom";
    goto cleanup;
  }

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored directories.";
  if (open_dir_chain_posix(
          root_dir, target_segs, target_seg_count, target_fds, target_dir_stats, &err_code,
          &err_stage, &err_msg) != 0) {
    res_reason = "target_parent_open_failed";
    goto cleanup;
  }
  if (open_dir_chain_posix(
          root_dir, staged_segs, staged_seg_count, staged_fds, staged_dir_stats, &err_code,
          &err_stage, &err_msg) != 0) {
    res_reason = "staged_parent_open_failed";
    goto cleanup;
  }

  int target_parent_fd = target_fds[target_seg_count];
  int staged_parent_fd = staged_fds[staged_seg_count];

  if (target_dir_stats[target_seg_count].dev != staged_dir_stats[staged_seg_count].dev) {
    res_status = "exdev";
    res_reason = "exdev";
    goto cleanup;
  }

  int rd_flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  int rw_flags = O_RDWR | O_NOFOLLOW | O_NONBLOCK;
#ifdef O_CLOEXEC
  rd_flags |= O_CLOEXEC;
  rw_flags |= O_CLOEXEC;
#endif

  /* Pre-check staged and target identities and pre-reserve unified lock registry slots BEFORE openat. */
  struct stat st;
  if (fstatat(staged_parent_fd, staged_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    res_reason = "staged_open_failed";
    goto cleanup;
  }
  staged_stat = stat_to_agy(&st);
  has_staged_stat = true;
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      !file_stat_exact_match(&staged_stat, expected_staged)) {
    res_reason = "staged_identity_mismatch";
    goto cleanup;
  }

  if (fstatat(target_parent_fd, target_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    res_reason = "target_open_failed";
    goto cleanup;
  }
  target_stat = stat_to_agy(&st);
  has_target_stat = true;
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      !file_stat_exact_match(&target_stat, expected_target)) {
    res_reason = "target_identity_mismatch";
    goto cleanup;
  }
  if (file_stat_inode_match(&staged_stat, &target_stat)) {
    res_reason = "same_inode";
    goto cleanup;
  }

  if (posix_reserve_fd_slot(target_stat.dev, target_stat.ino, true, true) != 0) {
    res_reason = "target_lock_contention";
    goto cleanup;
  }
  target_slot_reserved = true;
  if (posix_reserve_fd_slot(staged_stat.dev, staged_stat.ino, true, true) != 0) {
    res_reason = "staged_lock_contention";
    goto cleanup;
  }
  staged_slot_reserved = true;

  /* Open staged_fd read-write so we can acquire an exclusive SQLite F_WRLCK on staged too. */
  staged_fd = openat(staged_parent_fd, staged_leaf, rw_flags);
  if (staged_fd < 0) {
    res_reason = "staged_open_failed";
    goto cleanup;
  }
  if (fstat(staged_fd, &st) != 0) {
    res_reason = "staged_stat_failed";
    goto cleanup;
  }
  AgyFileStat opened_staged = stat_to_agy(&st);
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      !file_stat_exact_match(&opened_staged, expected_staged)) {
    posix_release_fd(staged_fd, opened_staged.dev, opened_staged.ino, AGY_LOCK_NONE, false);
    staged_fd = -1;
    res_reason = "staged_identity_mismatch";
    goto cleanup;
  }

  target_fd = openat(target_parent_fd, target_leaf, rw_flags);
  if (target_fd < 0) {
    res_reason = "target_open_failed";
    goto cleanup;
  }
  if (fstat(target_fd, &st) != 0) {
    res_reason = "target_stat_failed";
    goto cleanup;
  }
  AgyFileStat opened_target = stat_to_agy(&st);
  if (!S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      !file_stat_exact_match(&opened_target, expected_target)) {
    posix_release_fd(target_fd, opened_target.dev, opened_target.ino, AGY_LOCK_NONE, false);
    target_fd = -1;
    res_reason = "target_identity_mismatch";
    goto cleanup;
  }

  /* Acquire exclusive SQLite F_WRLCK on BOTH target_fd and staged_fd inside the unified lock registry. */
  if (posix_acquire_exclusive_lock(target_fd, target_stat.dev, target_stat.ino) != 0) {
    res_reason = "target_lock_contention";
    goto cleanup;
  }
  target_locked = true;

  if (posix_acquire_exclusive_lock(staged_fd, staged_stat.dev, staged_stat.ino) != 0) {
    res_reason = "staged_lock_contention";
    goto cleanup;
  }
  staged_locked = true;

  /* Re-verify anchored directory chains, fstat, and fstatat under both exclusive locks. */
  if (!verify_dir_chain_posix(
          root_dir, target_segs, target_seg_count, target_fds, target_dir_stats) ||
      !verify_dir_chain_posix(
          root_dir, staged_segs, staged_seg_count, staged_fds, staged_dir_stats)) {
    res_reason = "parent_changed";
    goto cleanup;
  }
  if (fstat(target_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "target_changed";
    goto cleanup;
  }
  AgyFileStat cur_target = stat_to_agy(&st);
  if (!file_stat_exact_match(&cur_target, expected_target)) {
    res_reason = "target_changed";
    goto cleanup;
  }
  if (fstatat(target_parent_fd, target_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "target_path_changed";
    goto cleanup;
  }
  AgyFileStat path_target = stat_to_agy(&st);
  if (!file_stat_exact_match(&path_target, expected_target)) {
    res_reason = "target_path_changed";
    goto cleanup;
  }

  if (fstat(staged_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "staged_changed";
    goto cleanup;
  }
  AgyFileStat cur_staged = stat_to_agy(&st);
  if (!file_stat_exact_match(&cur_staged, expected_staged)) {
    res_reason = "staged_changed";
    goto cleanup;
  }
  if (fstatat(staged_parent_fd, staged_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "staged_path_changed";
    goto cleanup;
  }
  AgyFileStat path_staged = stat_to_agy(&st);
  if (!file_stat_exact_match(&path_staged, expected_staged)) {
    res_reason = "staged_path_changed";
    goto cleanup;
  }

  /* Verify sidefiles by pinning FDs and checking WAL/SHM consistency BEFORE deleting anything. */
  if (fstatat(target_parent_fd, target_journal, &st, AT_SYMLINK_NOFOLLOW) == 0) {
    res_reason = "target_journal_present";
    goto cleanup;
  } else if (errno != ENOENT) {
    res_reason = "target_journal_stat_failed";
    goto cleanup;
  }

  bool has_zero_wal = false;
  wal_fd = openat(target_parent_fd, target_wal, rd_flags);
  if (wal_fd >= 0) {
    if (fstat(wal_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size != 0) {
      res_reason = "target_wal_nonempty_or_linked";
      goto cleanup;
    }
    wal_stat = stat_to_agy(&st);
    has_zero_wal = true;
  } else if (errno != ENOENT) {
    res_reason = "target_wal_stat_failed";
    goto cleanup;
  }

  bool has_valid_shm = false;
  shm_fd = openat(target_parent_fd, target_shm, rd_flags);
  if (shm_fd >= 0) {
    if (fstat(shm_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
      res_reason = "target_shm_invalid";
      goto cleanup;
    }
    shm_stat = stat_to_agy(&st);
    has_valid_shm = true;
  } else if (errno != ENOENT) {
    res_reason = "target_shm_stat_failed";
    goto cleanup;
  }

  /* Reject standalone -shm (has_shm && !has_wal) BEFORE any unlink! */
  if (has_valid_shm && !has_zero_wal) {
    res_reason = "standalone_shm";
    goto cleanup;
  }

  /* Re-verify pinned fstat and fstatat identity of -wal and -shm right before unlinking. */
  if (has_zero_wal) {
    if (fstat(wal_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size != 0) {
      res_reason = "target_wal_changed";
      goto cleanup;
    }
    AgyFileStat cur_wal = stat_to_agy(&st);
    if (!file_stat_exact_match(&cur_wal, &wal_stat)) {
      res_reason = "target_wal_changed";
      goto cleanup;
    }
    if (fstatat(target_parent_fd, target_wal, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size != 0) {
      res_reason = "target_wal_changed";
      goto cleanup;
    }
    AgyFileStat path_wal = stat_to_agy(&st);
    if (!file_stat_exact_match(&path_wal, &wal_stat)) {
      res_reason = "target_wal_changed";
      goto cleanup;
    }
  }
  if (has_valid_shm) {
    if (fstat(shm_fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1) {
      res_reason = "target_shm_changed";
      goto cleanup;
    }
    AgyFileStat cur_shm = stat_to_agy(&st);
    if (!file_stat_exact_match(&cur_shm, &shm_stat)) {
      res_reason = "target_shm_changed";
      goto cleanup;
    }
    if (fstatat(target_parent_fd, target_shm, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(st.st_mode) || st.st_nlink != 1) {
      res_reason = "target_shm_changed";
      goto cleanup;
    }
    AgyFileStat path_shm = stat_to_agy(&st);
    if (!file_stat_exact_match(&path_shm, &shm_stat)) {
      res_reason = "target_shm_changed";
      goto cleanup;
    }
  }

  /* Unlink verified 0-byte -wal and verified -shm under exclusive lock. */
  if (has_zero_wal) {
    if (unlinkat(target_parent_fd, target_wal, 0) != 0 && errno != ENOENT) {
      res_reason = "target_wal_unlink_failed";
      goto cleanup;
    }
  }
  if (has_valid_shm) {
    if (unlinkat(target_parent_fd, target_shm, 0) != 0 && errno != ENOENT) {
      res_reason = "target_shm_unlink_failed";
      goto cleanup;
    }
  }

  /* Final directory-entry identity verification right before renameat. */
  if (fstatat(target_parent_fd, target_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "target_path_changed";
    goto cleanup;
  }
  path_target = stat_to_agy(&st);
  if (!file_stat_exact_match(&path_target, expected_target)) {
    res_reason = "target_path_changed";
    goto cleanup;
  }
  if (fstatat(staged_parent_fd, staged_leaf, &st, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(st.st_mode) || st.st_nlink != 1) {
    res_reason = "staged_path_changed";
    goto cleanup;
  }
  path_staged = stat_to_agy(&st);
  if (!file_stat_exact_match(&path_staged, expected_staged)) {
    res_reason = "staged_path_changed";
    goto cleanup;
  }

  /* Atomic same-volume replacement while holding exclusive locks on both target and staged inodes. */
  if (renameat(staged_parent_fd, staged_leaf, target_parent_fd, target_leaf) != 0) {
    if (errno == EXDEV) {
      res_status = "exdev";
      res_reason = "exdev";
    } else {
      res_reason = "rename_failed";
    }
    goto cleanup;
  }

  while (fsync(target_parent_fd) != 0) {
    if (errno == EINTR) continue;
    /* Preserve the rename fact as uncertain rather than falsely claiming published durability. */
    res_status = "uncertain";
    res_reason = "dir_fsync_failed_after_rename";
    goto cleanup;
  }

  res_status = "published";
  res_reason = NULL;

cleanup:
  if (shm_fd >= 0) {
    close(shm_fd);
    shm_fd = -1;
  }
  if (wal_fd >= 0) {
    close(wal_fd);
    wal_fd = -1;
  }
  if (target_fd >= 0 || target_slot_reserved) {
    if (has_target_stat) {
      posix_release_fd(
          target_fd,
          target_stat.dev,
          target_stat.ino,
          target_locked ? AGY_LOCK_EXCLUSIVE : AGY_LOCK_NONE,
          target_slot_reserved);
    } else if (target_fd >= 0) {
      close(target_fd);
    }
    target_fd = -1;
    target_locked = false;
    target_slot_reserved = false;
  }
  if (staged_fd >= 0 || staged_slot_reserved) {
    if (has_staged_stat) {
      posix_release_fd(
          staged_fd,
          staged_stat.dev,
          staged_stat.ino,
          staged_locked ? AGY_LOCK_EXCLUSIVE : AGY_LOCK_NONE,
          staged_slot_reserved);
    } else if (staged_fd >= 0) {
      close(staged_fd);
    }
    staged_fd = -1;
    staged_locked = false;
    staged_slot_reserved = false;
  }
  close_dir_chain_posix(target_fds, target_seg_count);
  close_dir_chain_posix(staged_fds, staged_seg_count);
  free(target_wal);
  free(target_shm);
  free(target_journal);
  return create_publish_result(env, res_status, res_reason);
}

#else /* Windows */

#ifndef FILE_RENAME_FLAG_REPLACE_IF_EXISTS
#  define FILE_RENAME_FLAG_REPLACE_IF_EXISTS 0x00000001u
#endif
#ifndef FILE_RENAME_FLAG_POSIX_SEMANTICS
#  define FILE_RENAME_FLAG_POSIX_SEMANTICS 0x00000002u
#endif
#define AGY_FILE_RENAME_INFO_EX_CLASS ((FILE_INFO_BY_HANDLE_CLASS)22)

typedef struct {
  DWORD Flags;
  HANDLE RootDirectory;
  DWORD FileNameLength;
  WCHAR FileName[1];
} AgyFileRenameInfoEx;

typedef struct {
  uint64_t volume_serial;
  uint8_t file_id[16];
  int64_t size;
  int64_t mtime_ns;
  int64_t ctime_ns;
} AgyFileStat;

typedef struct {
  bool closed;
  bool shared_lock_held;
  bool track_wal;
  bool track_shm;
  bool track_journal;
  bool has_wal;
  bool has_shm;
  bool has_journal;
  char* root_dir;
  size_t segment_count;
  char* segments[AGY_MAX_PARENT_SEGMENTS];
  char* leaf_name;
  char* wal_name;
  char* shm_name;
  char* journal_name;
  HANDLE dir_handles[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  wchar_t* dir_final_paths[AGY_MAX_PARENT_SEGMENTS + 1];
  HANDLE db_handle;
  AgyFileStat db_stat;
  HANDLE wal_handle;
  AgyFileStat wal_stat;
  HANDLE shm_handle;
  AgyFileStat shm_stat;
} AgyLockedView;

static const char* winerr_to_code(DWORD err) {
  switch (err) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return "ENOENT";
    case ERROR_LOCK_VIOLATION:
    case ERROR_SHARING_VIOLATION:
      return "EBUSY";
    case ERROR_ACCESS_DENIED:
      return "EACCES";
    case ERROR_DIRECTORY:
      return "ENOTDIR";
    case ERROR_CANT_ACCESS_FILE:
    case ERROR_REPARSE_TAG_INVALID:
    case ERROR_REPARSE_TAG_MISMATCH:
      return "ELOOP";
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL:
      return "ENOSPC";
    case ERROR_TOO_MANY_OPEN_FILES:
      return "EMFILE";
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      return "ENOMEM";
    default:
      return "EIO";
  }
}

static wchar_t* utf8_to_wide(const char* src) {
  int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, src, -1, NULL, 0);
  if (needed <= 0) return NULL;
  wchar_t* out = (wchar_t*)malloc((size_t)needed * sizeof(wchar_t));
  if (!out) return NULL;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, src, -1, out, needed) != needed) {
    free(out);
    return NULL;
  }
  return out;
}

static wchar_t* join_wide_path(const wchar_t* dir, const wchar_t* child) {
  size_t dlen = wcslen(dir);
  size_t clen = wcslen(child);
  bool needs_sep = dlen > 0 && dir[dlen - 1] != L'\\' && dir[dlen - 1] != L'/';
  wchar_t* out = (wchar_t*)malloc((dlen + (needs_sep ? 1 : 0) + clen + 1) * sizeof(wchar_t));
  if (!out) return NULL;
  memcpy(out, dir, dlen * sizeof(wchar_t));
  size_t pos = dlen;
  if (needs_sep) out[pos++] = L'\\';
  memcpy(out + pos, child, (clen + 1) * sizeof(wchar_t));
  return out;
}

static wchar_t* get_final_path_wide(HANDLE h) {
  DWORD needed = GetFinalPathNameByHandleW(h, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (needed == 0 || needed > 32768) return NULL;
  wchar_t* buf = (wchar_t*)malloc((size_t)(needed + 1) * sizeof(wchar_t));
  if (!buf) return NULL;
  DWORD got = GetFinalPathNameByHandleW(h, buf, needed + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (got == 0 || got > needed) {
    free(buf);
    return NULL;
  }
  buf[got] = L'\0';
  return buf;
}

static int64_t win_ticks_to_unix_ns(int64_t ticks_1601) {
  const int64_t EPOCH_DIFF_TICKS = 116444736000000000LL;
  const int64_t MAX_UNIX_TICKS = INT64_MAX / 100LL;
  const int64_t MIN_UNIX_TICKS = INT64_MIN / 100LL;
  if (ticks_1601 < INT64_MIN + EPOCH_DIFF_TICKS) return INT64_MIN;
  int64_t unix_ticks = ticks_1601 - EPOCH_DIFF_TICKS;
  if (unix_ticks > MAX_UNIX_TICKS) return INT64_MAX;
  if (unix_ticks < MIN_UNIX_TICKS) return INT64_MIN;
  return unix_ticks * 100LL;
}

static bool query_win_file_stat(
    HANDLE h, bool expect_dir, bool require_single_link, AgyFileStat* out, DWORD* out_err) {
  FILE_BASIC_INFO basic;
  FILE_STANDARD_INFO std_info;
  FILE_ID_INFO id_info;
  if (!GetFileInformationByHandleEx(h, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(h, FileStandardInfo, &std_info, sizeof(std_info)) ||
      !GetFileInformationByHandleEx(h, FileIdInfo, &id_info, sizeof(id_info))) {
    *out_err = GetLastError();
    return false;
  }
  if ((basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *out_err = ERROR_REPARSE_TAG_INVALID;
    return false;
  }
  bool is_dir = (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (is_dir != expect_dir) {
    *out_err = expect_dir ? ERROR_DIRECTORY : ERROR_ACCESS_DENIED;
    return false;
  }
  if (std_info.DeletePending) {
    *out_err = ERROR_FILE_NOT_FOUND;
    return false;
  }
  if (!expect_dir && require_single_link && std_info.NumberOfLinks != 1) {
    *out_err = ERROR_INVALID_PARAMETER;
    return false;
  }
  out->volume_serial = (uint64_t)id_info.VolumeSerialNumber;
  memcpy(out->file_id, id_info.FileId.Identifier, 16);
  out->size = (int64_t)std_info.EndOfFile.QuadPart;
  out->mtime_ns = win_ticks_to_unix_ns((int64_t)basic.LastWriteTime.QuadPart);
  out->ctime_ns = win_ticks_to_unix_ns((int64_t)basic.ChangeTime.QuadPart);
  return true;
}

static bool parse_identity_arg(napi_env env, napi_value obj, AgyFileStat* out) {
  char* dev_s = dup_named_str_prop(env, obj, "dev", 64);
  char* ino_s = dup_named_str_prop(env, obj, "ino", 64);
  char* size_s = dup_named_str_prop(env, obj, "size", 64);
  char* mtime_s = dup_named_str_prop(env, obj, "mtimeNs", 64);
  char* ctime_s = dup_named_str_prop(env, obj, "ctimeNs", 64);
  bool ok = dev_s && ino_s && size_s && mtime_s && ctime_s &&
            parse_hex_u64(dev_s, &out->volume_serial) && parse_hex_bytes16(ino_s, out->file_id) &&
            parse_dec_i64(size_s, &out->size) && parse_dec_i64(mtime_s, &out->mtime_ns) &&
            parse_dec_i64(ctime_s, &out->ctime_ns);
  free(dev_s);
  free(ino_s);
  free(size_s);
  free(mtime_s);
  free(ctime_s);
  return ok;
}

static bool file_stat_exact_match(const AgyFileStat* a, const AgyFileStat* b) {
  return a->volume_serial == b->volume_serial && memcmp(a->file_id, b->file_id, 16) == 0 &&
         a->size == b->size && a->mtime_ns == b->mtime_ns && a->ctime_ns == b->ctime_ns;
}

static bool file_stat_inode_match(const AgyFileStat* a, const AgyFileStat* b) {
  return a->volume_serial == b->volume_serial && memcmp(a->file_id, b->file_id, 16) == 0;
}

static napi_value create_identity_object(napi_env env, const AgyFileStat* st) {
  napi_value obj = NULL;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  char buf[64];
  snprintf(buf, sizeof(buf), "%016llx", (unsigned long long)st->volume_serial);
  set_str_prop(env, obj, "dev", buf);
  char id_hex[33];
  for (int i = 0; i < 16; i++) {
    snprintf(id_hex + i * 2, 3, "%02x", st->file_id[i]);
  }
  id_hex[32] = '\0';
  set_str_prop(env, obj, "ino", id_hex);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->size);
  set_str_prop(env, obj, "size", buf);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->mtime_ns);
  set_str_prop(env, obj, "mtimeNs", buf);
  snprintf(buf, sizeof(buf), "%lld", (long long)st->ctime_ns);
  set_str_prop(env, obj, "ctimeNs", buf);
  return obj;
}

static DWORD acquire_sqlite_shared_lock_win(HANDLE h) {
  OVERLAPPED ov_pending;
  memset(&ov_pending, 0, sizeof(ov_pending));
  ov_pending.Offset = SQLITE_PENDING_BYTE;
  if (!LockFileEx(h, LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov_pending)) {
    return GetLastError();
  }
  OVERLAPPED ov_shared;
  memset(&ov_shared, 0, sizeof(ov_shared));
  ov_shared.Offset = SQLITE_SHARED_FIRST;
  if (!LockFileEx(h, LOCKFILE_FAIL_IMMEDIATELY, 0, SQLITE_SHARED_SIZE, 0, &ov_shared)) {
    DWORD err = GetLastError();
    (void)UnlockFileEx(h, 0, 1, 0, &ov_pending);
    return err;
  }
  (void)UnlockFileEx(h, 0, 1, 0, &ov_pending);
  return ERROR_SUCCESS;
}

static void release_sqlite_shared_lock_win(HANDLE h) {
  OVERLAPPED ov_shared;
  memset(&ov_shared, 0, sizeof(ov_shared));
  ov_shared.Offset = SQLITE_SHARED_FIRST;
  (void)UnlockFileEx(h, 0, SQLITE_SHARED_SIZE, 0, &ov_shared);
}

static void view_close_handles(AgyLockedView* v) {
  if (!v || v->closed) return;
  v->closed = true;
  if (v->db_handle != INVALID_HANDLE_VALUE && v->shared_lock_held) {
    release_sqlite_shared_lock_win(v->db_handle);
    v->shared_lock_held = false;
  }
  if (v->shm_handle != INVALID_HANDLE_VALUE) {
    CloseHandle(v->shm_handle);
    v->shm_handle = INVALID_HANDLE_VALUE;
  }
  if (v->wal_handle != INVALID_HANDLE_VALUE) {
    CloseHandle(v->wal_handle);
    v->wal_handle = INVALID_HANDLE_VALUE;
  }
  if (v->db_handle != INVALID_HANDLE_VALUE) {
    CloseHandle(v->db_handle);
    v->db_handle = INVALID_HANDLE_VALUE;
  }
  for (size_t i = 0; i <= v->segment_count; i++) {
    if (v->dir_handles[i] != INVALID_HANDLE_VALUE) {
      CloseHandle(v->dir_handles[i]);
      v->dir_handles[i] = INVALID_HANDLE_VALUE;
    }
  }
}

static void view_destroy(AgyLockedView* v) {
  if (!v) return;
  view_close_handles(v);
  free(v->root_dir);
  for (size_t i = 0; i < v->segment_count; i++) {
    free(v->segments[i]);
  }
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    free(v->dir_final_paths[i]);
  }
  free(v->leaf_name);
  free(v->wal_name);
  free(v->shm_name);
  free(v->journal_name);
  free(v);
}

static napi_value view_read_handle(napi_env env, HANDLE h, int64_t offset, int64_t length) {
  if (offset < 0 || length < 0 || length > AGY_MAX_READ_BYTES) {
    return throw_coded_error(env, "EINVAL", "read", "Invalid offset or length for native readAt.");
  }
  void* raw = NULL;
  napi_value buf = NULL;
  if (napi_create_buffer(env, (size_t)length, &raw, &buf) != napi_ok) {
    return throw_coded_error(env, "ENOMEM", "read", "Failed to allocate read buffer.");
  }
  if (length == 0) return buf;
  uint8_t* dst = (uint8_t*)raw;
  int64_t done = 0;
  while (done < length) {
    OVERLAPPED ov;
    memset(&ov, 0, sizeof(ov));
    uint64_t pos = (uint64_t)(offset + done);
    ov.Offset = (DWORD)(pos & 0xffffffffULL);
    ov.OffsetHigh = (DWORD)(pos >> 32);
    DWORD chunk = (DWORD)((length - done) > 0x1000000LL ? 0x1000000LL : (length - done));
    DWORD got = 0;
    if (!ReadFile(h, dst + done, chunk, &got, &ov)) {
      DWORD err = GetLastError();
      if (err == ERROR_HANDLE_EOF) {
        return throw_coded_error(
            env, "ERR_UNEXPECTED_EOF", "read", "Unexpected EOF during native ReadFile.");
      }
      return throw_coded_error(env, winerr_to_code(err), "read", "Native ReadFile failed.");
    }
    if (got == 0) {
      return throw_coded_error(
          env, "ERR_UNEXPECTED_EOF", "read", "Unexpected EOF during native ReadFile.");
    }
    done += (int64_t)got;
  }
  return buf;
}

static bool win_path_exists_no_reparse(const wchar_t* path, int64_t* out_size, DWORD* out_err) {
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
    DWORD err = GetLastError();
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
      *out_err = ERROR_SUCCESS;
      return false;
    }
    *out_err = err;
    return false;
  }
  if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *out_err = ERROR_REPARSE_TAG_INVALID;
    return true;
  }
  if (out_size) {
    ULARGE_INTEGER sz;
    sz.LowPart = data.nFileSizeLow;
    sz.HighPart = data.nFileSizeHigh;
    *out_size = (int64_t)sz.QuadPart;
  }
  *out_err = ERROR_SUCCESS;
  return true;
}

static bool win_handle_still_under_parent(HANDLE h, const wchar_t* parent_path, const char* name) {
  wchar_t* leaf_w = utf8_to_wide(name);
  if (!leaf_w) return false;
  wchar_t* expected = join_wide_path(parent_path, leaf_w);
  free(leaf_w);
  if (!expected) return false;
  wchar_t* actual = get_final_path_wide(h);
  bool ok = actual != NULL && _wcsicmp(actual, expected) == 0;
  free(actual);
  free(expected);
  return ok;
}

static bool verify_dir_chain_win(
    const char* root_dir,
    char* const* segments,
    size_t segment_count,
    const HANDLE dir_handles[AGY_MAX_PARENT_SEGMENTS + 1],
    const AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1],
    wchar_t* const dir_final_paths[AGY_MAX_PARENT_SEGMENTS + 1]) {
  DWORD err = 0;
  AgyFileStat cur;
  /* Confirm the configured root path still points to the same root directory identity. */
  wchar_t* root_w = utf8_to_wide(root_dir);
  if (!root_w) return false;
  HANDLE root_probe = CreateFileW(
      root_w,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  free(root_w);
  if (root_probe == INVALID_HANDLE_VALUE) return false;
  bool root_ok = query_win_file_stat(root_probe, true, false, &cur, &err) &&
                 file_stat_inode_match(&dir_stats[0], &cur);
  CloseHandle(root_probe);
  if (!root_ok) return false;

  /* Verify every pinned directory handle, its canonical final path, and adjacent parent-child linkage. */
  for (size_t i = 0; i <= segment_count; i++) {
    if (dir_handles[i] == INVALID_HANDLE_VALUE || !dir_final_paths[i]) return false;
    if (!query_win_file_stat(dir_handles[i], true, false, &cur, &err) ||
        !file_stat_inode_match(&dir_stats[i], &cur)) {
      return false;
    }
    wchar_t* cur_path = get_final_path_wide(dir_handles[i]);
    bool path_ok = cur_path != NULL && _wcsicmp(cur_path, dir_final_paths[i]) == 0;
    free(cur_path);
    if (!path_ok) return false;
    if (i > 0 && !win_handle_still_under_parent(
                     dir_handles[i], dir_final_paths[i - 1], segments[i - 1])) {
      return false;
    }
  }
  return true;
}

static const char* view_verify_unchanged_impl(AgyLockedView* v) {
  if (!v || v->closed || v->db_handle == INVALID_HANDLE_VALUE ||
      !v->dir_final_paths[v->segment_count]) {
    return "closed";
  }
  const wchar_t* parent_final_path = v->dir_final_paths[v->segment_count];
  DWORD err = 0;
  AgyFileStat cur;
  if (!verify_dir_chain_win(
          v->root_dir, v->segments, v->segment_count, v->dir_handles, v->dir_stats,
          v->dir_final_paths)) {
    return "parent_changed";
  }

  /* Re-check pinned DB handle and verify it was not renamed/replaced under parent. */
  if (!query_win_file_stat(v->db_handle, false, true, &cur, &err) ||
      !file_stat_exact_match(&v->db_stat, &cur) ||
      !win_handle_still_under_parent(v->db_handle, parent_final_path, v->leaf_name)) {
    return "db_changed";
  }

  /* Check journal absence. */
  if (v->track_journal) {
    wchar_t* j_w = utf8_to_wide(v->journal_name);
    if (!j_w) return "journal_stat_failed";
    wchar_t* j_path = join_wide_path(parent_final_path, j_w);
    free(j_w);
    if (!j_path) return "journal_stat_failed";
    bool j_exists = win_path_exists_no_reparse(j_path, NULL, &err);
    free(j_path);
    if (err != ERROR_SUCCESS) return "journal_stat_failed";
    if (j_exists && !v->has_journal) return "journal_appeared";
  }

  /* Check WAL identity/absence. */
  if (v->track_wal) {
    if (!v->has_wal) {
      wchar_t* w_w = utf8_to_wide(v->wal_name);
      if (!w_w) return "wal_stat_failed";
      wchar_t* w_path = join_wide_path(parent_final_path, w_w);
      free(w_w);
      if (!w_path) return "wal_stat_failed";
      bool w_exists = win_path_exists_no_reparse(w_path, NULL, &err);
      free(w_path);
      if (err != ERROR_SUCCESS || w_exists) return "wal_appeared";
    } else {
      if (!query_win_file_stat(v->wal_handle, false, true, &cur, &err) ||
          !file_stat_exact_match(&v->wal_stat, &cur) ||
          !win_handle_still_under_parent(v->wal_handle, parent_final_path, v->wal_name)) {
        return "wal_changed";
      }
    }
  }

  /* Check SHM identity/absence. */
  if (v->track_shm) {
    if (!v->has_shm) {
      wchar_t* s_w = utf8_to_wide(v->shm_name);
      if (!s_w) return "shm_stat_failed";
      wchar_t* s_path = join_wide_path(parent_final_path, s_w);
      free(s_w);
      if (!s_path) return "shm_stat_failed";
      bool s_exists = win_path_exists_no_reparse(s_path, NULL, &err);
      free(s_path);
      if (err != ERROR_SUCCESS || s_exists) return "shm_appeared";
    } else {
      if (!query_win_file_stat(v->shm_handle, false, true, &cur, &err) ||
          !file_stat_inode_match(&v->shm_stat, &cur) ||
          !win_handle_still_under_parent(v->shm_handle, parent_final_path, v->shm_name)) {
        return "shm_changed";
      }
    }
  }
  return NULL;
}

static void close_dir_chain_win(
    HANDLE dir_handles[AGY_MAX_PARENT_SEGMENTS + 1],
    wchar_t* dir_final_paths[AGY_MAX_PARENT_SEGMENTS + 1],
    size_t segment_count) {
  for (size_t i = 0; i <= segment_count; i++) {
    if (dir_handles[i] != INVALID_HANDLE_VALUE) {
      CloseHandle(dir_handles[i]);
      dir_handles[i] = INVALID_HANDLE_VALUE;
    }
    free(dir_final_paths[i]);
    dir_final_paths[i] = NULL;
  }
}

static int open_dir_chain_win(
    const char* root_dir,
    char* const* segments,
    size_t segment_count,
    HANDLE dir_handles[AGY_MAX_PARENT_SEGMENTS + 1],
    AgyFileStat dir_stats[AGY_MAX_PARENT_SEGMENTS + 1],
    wchar_t* dir_final_paths[AGY_MAX_PARENT_SEGMENTS + 1],
    const char** err_code,
    const char** err_stage,
    const char** err_msg) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    dir_handles[i] = INVALID_HANDLE_VALUE;
    dir_final_paths[i] = NULL;
  }
  wchar_t* cur_path = utf8_to_wide(root_dir);
  if (!cur_path) {
    *err_code = "EINVAL";
    *err_stage = "root";
    *err_msg = "Invalid UTF-8 root path.";
    return -1;
  }
  /* Request FILE_TRAVERSE | FILE_READ_ATTRIBUTES while omitting FILE_SHARE_DELETE so NTFS
   * participates in sharing checks and prevents ancestor directories from being renamed or
   * replaced while traversal or view verification holds these guard handles. */
  DWORD dir_access = FILE_TRAVERSE | FILE_READ_ATTRIBUTES;
  DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE;
  DWORD dir_flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
  HANDLE h = CreateFileW(cur_path, dir_access, share, NULL, OPEN_EXISTING, dir_flags, NULL);
  free(cur_path);
  if (h == INVALID_HANDLE_VALUE) {
    *err_code = winerr_to_code(GetLastError());
    *err_stage = "root";
    *err_msg = "Failed to open anchored storage root directory.";
    return -1;
  }
  DWORD err = 0;
  if (!query_win_file_stat(h, true, false, &dir_stats[0], &err)) {
    CloseHandle(h);
    *err_code = winerr_to_code(err);
    *err_stage = "root";
    *err_msg = "Storage root is linked or not an ordinary directory.";
    return -1;
  }
  dir_handles[0] = h;
  dir_final_paths[0] = get_final_path_wide(h);
  if (!dir_final_paths[0]) {
    *err_code = "EIO";
    *err_stage = "root";
    *err_msg = "Failed to resolve canonical root handle path.";
    return -1;
  }

  for (size_t i = 0; i < segment_count; i++) {
    wchar_t* seg_w = utf8_to_wide(segments[i]);
    if (!seg_w) {
      *err_code = "EINVAL";
      *err_stage = "parent";
      *err_msg = "Invalid UTF-8 parent segment.";
      return -1;
    }
    wchar_t* next_path = join_wide_path(dir_final_paths[i], seg_w);
    free(seg_w);
    if (!next_path) {
      *err_code = "ENOMEM";
      *err_stage = "parent";
      *err_msg = "Out of memory building parent path.";
      return -1;
    }
    HANDLE nh = CreateFileW(
        next_path, dir_access, share, NULL, OPEN_EXISTING, dir_flags, NULL);
    free(next_path);
    if (nh == INVALID_HANDLE_VALUE) {
      *err_code = winerr_to_code(GetLastError());
      *err_stage = "parent";
      *err_msg = "Failed to open anchored parent directory segment.";
      return -1;
    }
    if (!query_win_file_stat(nh, true, false, &dir_stats[i + 1], &err)) {
      CloseHandle(nh);
      *err_code = winerr_to_code(err);
      *err_stage = "parent";
      *err_msg = "Parent segment is linked or not an ordinary directory.";
      return -1;
    }
    if (!win_handle_still_under_parent(nh, dir_final_paths[i], segments[i])) {
      CloseHandle(nh);
      *err_code = "ELOOP";
      *err_stage = "parent";
      *err_msg = "Parent directory segment escaped its anchored parent.";
      return -1;
    }
    dir_handles[i + 1] = nh;
    dir_final_paths[i + 1] = get_final_path_wide(nh);
    if (!dir_final_paths[i + 1]) {
      *err_code = "EIO";
      *err_stage = "parent";
      *err_msg = "Failed to resolve canonical parent handle path.";
      return -1;
    }
  }
  return 0;
}

static int open_anchored_dirs_win(
    AgyLockedView* v, const char** err_code, const char** err_stage, const char** err_msg) {
  return open_dir_chain_win(
      v->root_dir, v->segments, v->segment_count, v->dir_handles, v->dir_stats, v->dir_final_paths,
      err_code, err_stage, err_msg);
}

static HANDLE open_child_file_win(const wchar_t* parent_path, const char* name, DWORD* out_err) {
  wchar_t* name_w = utf8_to_wide(name);
  if (!name_w) {
    *out_err = ERROR_INVALID_PARAMETER;
    return INVALID_HANDLE_VALUE;
  }
  wchar_t* full = join_wide_path(parent_path, name_w);
  free(name_w);
  if (!full) {
    *out_err = ERROR_OUTOFMEMORY;
    return INVALID_HANDLE_VALUE;
  }
  HANDLE h = CreateFileW(
      full,
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_RANDOM_ACCESS,
      NULL);
  free(full);
  if (h == INVALID_HANDLE_VALUE) {
    *out_err = GetLastError();
  } else {
    *out_err = ERROR_SUCCESS;
  }
  return h;
}

static bool probe_ordinary_sidefile_win(
    const wchar_t* parent_path,
    const char* name,
    bool* out_exists,
    AgyFileStat* out_stat,
    DWORD* out_err) {
  *out_exists = false;
  wchar_t* name_w = utf8_to_wide(name);
  if (!name_w) {
    *out_err = ERROR_INVALID_PARAMETER;
    return false;
  }
  wchar_t* full = join_wide_path(parent_path, name_w);
  free(name_w);
  if (!full) {
    *out_err = ERROR_OUTOFMEMORY;
    return false;
  }
  HANDLE h = CreateFileW(
      full,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  free(full);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD e = GetLastError();
    if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) {
      *out_err = ERROR_SUCCESS;
      return true;
    }
    *out_err = e;
    return false;
  }
  bool ok = query_win_file_stat(h, false, true, out_stat, out_err);
  if (ok && !win_handle_still_under_parent(h, parent_path, name)) {
    ok = false;
    *out_err = ERROR_REPARSE_TAG_INVALID;
  }
  CloseHandle(h);
  if (ok) *out_exists = true;
  return ok;
}

static bool open_anchored_view_platform(
    napi_env env,
    AgyLockedView* v,
    bool acquire_lock,
    bool open_wal,
    bool open_shm,
    bool check_journal) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    v->dir_handles[i] = INVALID_HANDLE_VALUE;
    v->dir_final_paths[i] = NULL;
  }
  v->db_handle = INVALID_HANDLE_VALUE;
  v->wal_handle = INVALID_HANDLE_VALUE;
  v->shm_handle = INVALID_HANDLE_VALUE;
  v->track_wal = open_wal;
  v->track_shm = open_shm;
  v->track_journal = check_journal;

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored SQLite view.";
  if (open_anchored_dirs_win(v, &err_code, &err_stage, &err_msg) != 0) {
    view_destroy(v);
    throw_coded_error(env, err_code, err_stage, err_msg);
    return false;
  }
  const wchar_t* parent_final_path = v->dir_final_paths[v->segment_count];

  DWORD err = 0;
  if (check_journal) {
    wchar_t* j_w = utf8_to_wide(v->journal_name);
    wchar_t* j_path = j_w ? join_wide_path(parent_final_path, j_w) : NULL;
    free(j_w);
    if (!j_path) {
      view_destroy(v);
      throw_coded_error(env, "ENOMEM", "journal", "Out of memory checking journal.");
      return false;
    }
    bool j_exists = win_path_exists_no_reparse(j_path, NULL, &err);
    free(j_path);
    if (err != ERROR_SUCCESS) {
      view_destroy(v);
      throw_coded_error(env, winerr_to_code(err), "journal", "Failed to inspect journal.");
      return false;
    }
    v->has_journal = j_exists;
  }

  HANDLE db_h = open_child_file_win(parent_final_path, v->leaf_name, &err);
  if (db_h == INVALID_HANDLE_VALUE) {
    view_destroy(v);
    throw_coded_error(
        env, winerr_to_code(err), "leaf", "Failed to open anchored SQLite database file.");
    return false;
  }
  v->db_handle = db_h;
  if (!query_win_file_stat(db_h, false, true, &v->db_stat, &err)) {
    view_destroy(v);
    throw_coded_error(
        env,
        err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
        "leaf",
        "SQLite database must be one ordinary single-link regular file.");
    return false;
  }

  if (acquire_lock) {
    DWORD lock_err = acquire_sqlite_shared_lock_win(db_h);
    if (lock_err != ERROR_SUCCESS) {
      view_destroy(v);
      throw_coded_error(
          env,
          lock_err == ERROR_LOCK_VIOLATION ? "EBUSY" : winerr_to_code(lock_err),
          "lock",
          "SQLite database is locked by an active writer.");
      return false;
    }
    v->shared_lock_held = true;
  }

  if (open_wal) {
    HANDLE wh = open_child_file_win(parent_final_path, v->wal_name, &err);
    if (wh != INVALID_HANDLE_VALUE) {
      v->wal_handle = wh;
      if (!query_win_file_stat(wh, false, true, &v->wal_stat, &err)) {
        view_destroy(v);
        throw_coded_error(
            env,
            err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
            "wal",
            "SQLite WAL sidefile must be one ordinary single-link file.");
        return false;
      }
      v->has_wal = true;
    } else if (err != ERROR_FILE_NOT_FOUND && err != ERROR_PATH_NOT_FOUND) {
      view_destroy(v);
      throw_coded_error(env, winerr_to_code(err), "wal", "Failed to open anchored WAL file.");
      return false;
    }
  }

  if (open_shm) {
    HANDLE sh = open_child_file_win(parent_final_path, v->shm_name, &err);
    if (sh != INVALID_HANDLE_VALUE) {
      v->shm_handle = sh;
      if (!query_win_file_stat(sh, false, true, &v->shm_stat, &err)) {
        view_destroy(v);
        throw_coded_error(
            env,
            err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
            "shm",
            "SQLite SHM sidefile must be one ordinary single-link file.");
        return false;
      }
      v->has_shm = true;
    } else if (err != ERROR_FILE_NOT_FOUND && err != ERROR_PATH_NOT_FOUND) {
      view_destroy(v);
      throw_coded_error(env, winerr_to_code(err), "shm", "Failed to open anchored SHM file.");
      return false;
    }
  }

  if (check_journal && !v->has_journal) {
    wchar_t* j_w = utf8_to_wide(v->journal_name);
    wchar_t* j_path = j_w ? join_wide_path(parent_final_path, j_w) : NULL;
    free(j_w);
    if (!j_path) {
      view_destroy(v);
      throw_coded_error(env, "ENOMEM", "journal", "Out of memory re-checking journal.");
      return false;
    }
    bool j_exists = win_path_exists_no_reparse(j_path, NULL, &err);
    free(j_path);
    if (err != ERROR_SUCCESS) {
      view_destroy(v);
      throw_coded_error(env, winerr_to_code(err), "journal", "Failed to re-check journal.");
      return false;
    }
    v->has_journal = j_exists;
  }

  return true;
}

static napi_value verify_candidate_platform(napi_env env, AgyLockedView* v) {
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    v->dir_handles[i] = INVALID_HANDLE_VALUE;
    v->dir_final_paths[i] = NULL;
  }
  v->db_handle = INVALID_HANDLE_VALUE;
  v->wal_handle = INVALID_HANDLE_VALUE;
  v->shm_handle = INVALID_HANDLE_VALUE;

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to inspect candidate SQLite file.";
  if (open_anchored_dirs_win(v, &err_code, &err_stage, &err_msg) != 0) {
    view_destroy(v);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  const wchar_t* parent_final_path = v->dir_final_paths[v->segment_count];

  DWORD err = 0;
  HANDLE db_h = open_child_file_win(parent_final_path, v->leaf_name, &err);
  if (db_h == INVALID_HANDLE_VALUE) {
    view_destroy(v);
    return throw_coded_error(
        env, winerr_to_code(err), "leaf", "Failed to open candidate SQLite database.");
  }
  v->db_handle = db_h;
  AgyFileStat db_stat;
  if (!query_win_file_stat(db_h, false, true, &db_stat, &err)) {
    view_destroy(v);
    return throw_coded_error(
        env,
        err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
        "leaf",
        "Candidate database must be one ordinary single-link file.");
  }

  bool has_active_lock = false;
  OVERLAPPED ov_all;
  memset(&ov_all, 0, sizeof(ov_all));
  ov_all.Offset = SQLITE_PENDING_BYTE;
  if (LockFileEx(
          db_h,
          LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
          0,
          SQLITE_LOCK_SPAN,
          0,
          &ov_all)) {
    (void)UnlockFileEx(db_h, 0, SQLITE_LOCK_SPAN, 0, &ov_all);
  } else {
    DWORD le = GetLastError();
    if (le == ERROR_LOCK_VIOLATION) {
      has_active_lock = true;
    } else {
      view_destroy(v);
      return throw_coded_error(
          env, winerr_to_code(le), "lock", "Failed to probe SQLite locks on candidate database.");
    }
  }

  bool has_journal = false;
  wchar_t* j_w = utf8_to_wide(v->journal_name);
  wchar_t* j_path = j_w ? join_wide_path(parent_final_path, j_w) : NULL;
  free(j_w);
  if (!j_path) {
    view_destroy(v);
    return throw_coded_error(env, "ENOMEM", "journal", "Out of memory inspecting journal.");
  }
  has_journal = win_path_exists_no_reparse(j_path, NULL, &err);
  free(j_path);
  if (err != ERROR_SUCCESS) {
    view_destroy(v);
    return throw_coded_error(env, winerr_to_code(err), "journal", "Failed to inspect journal.");
  }

  bool has_wal = false;
  AgyFileStat wal_stat;
  memset(&wal_stat, 0, sizeof(wal_stat));
  if (!probe_ordinary_sidefile_win(parent_final_path, v->wal_name, &has_wal, &wal_stat, &err)) {
    view_destroy(v);
    return throw_coded_error(
        env,
        err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
        "wal",
        "Candidate WAL sidefile must be one ordinary single-link file.");
  }
  int64_t wal_bytes = has_wal ? wal_stat.size : 0;

  bool has_shm = false;
  AgyFileStat shm_stat;
  memset(&shm_stat, 0, sizeof(shm_stat));
  if (!probe_ordinary_sidefile_win(parent_final_path, v->shm_name, &has_shm, &shm_stat, &err)) {
    view_destroy(v);
    return throw_coded_error(
        env,
        err == ERROR_INVALID_PARAMETER ? "ELINK" : winerr_to_code(err),
        "shm",
        "Candidate SHM sidefile must be one ordinary single-link file.");
  }

  view_destroy(v);

  napi_value out = NULL;
  if (napi_create_object(env, &out) != napi_ok) return NULL;
  set_double_prop(env, out, "byteLength", (double)db_stat.size);
  set_bool_prop(env, out, "hasActiveLock", has_active_lock);
  set_bool_prop(env, out, "hasJournal", has_journal);
  set_bool_prop(env, out, "hasWal", has_wal);
  set_double_prop(env, out, "walByteLength", (double)wal_bytes);
  set_bool_prop(env, out, "hasShm", has_shm);
  napi_value id_obj = create_identity_object(env, &db_stat);
  if (id_obj) napi_set_named_property(env, out, "fileIdentity", id_obj);
  return out;
}

static napi_value check_same_volume_platform(
    napi_env env,
    const char* root_dir,
    char* const* left_segs,
    size_t left_count,
    char* const* right_segs,
    size_t right_count) {
  HANDLE left_handles[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat left_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  wchar_t* left_paths[AGY_MAX_PARENT_SEGMENTS + 1];
  HANDLE right_handles[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat right_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  wchar_t* right_paths[AGY_MAX_PARENT_SEGMENTS + 1];
  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored directories for volume check.";

  if (open_dir_chain_win(
          root_dir, left_segs, left_count, left_handles, left_stats, left_paths, &err_code,
          &err_stage, &err_msg) != 0) {
    close_dir_chain_win(left_handles, left_paths, left_count);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  if (open_dir_chain_win(
          root_dir, right_segs, right_count, right_handles, right_stats, right_paths, &err_code,
          &err_stage, &err_msg) != 0) {
    close_dir_chain_win(left_handles, left_paths, left_count);
    close_dir_chain_win(right_handles, right_paths, right_count);
    return throw_coded_error(env, err_code, err_stage, err_msg);
  }
  bool same = left_stats[left_count].volume_serial == right_stats[right_count].volume_serial;
  close_dir_chain_win(left_handles, left_paths, left_count);
  close_dir_chain_win(right_handles, right_paths, right_count);
  napi_value out = NULL;
  if (napi_get_boolean(env, same, &out) != napi_ok) return NULL;
  return out;
}

static napi_value publish_candidate_atomically_platform(
    napi_env env,
    const char* root_dir,
    char* const* target_segs,
    size_t target_seg_count,
    const char* target_leaf,
    char* const* staged_segs,
    size_t staged_seg_count,
    const char* staged_leaf,
    const AgyFileStat* expected_target,
    const AgyFileStat* expected_staged) {
  HANDLE target_handles[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat target_dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  wchar_t* target_dir_paths[AGY_MAX_PARENT_SEGMENTS + 1];
  HANDLE staged_handles[AGY_MAX_PARENT_SEGMENTS + 1];
  AgyFileStat staged_dir_stats[AGY_MAX_PARENT_SEGMENTS + 1];
  wchar_t* staged_dir_paths[AGY_MAX_PARENT_SEGMENTS + 1];
  for (size_t i = 0; i <= AGY_MAX_PARENT_SEGMENTS; i++) {
    target_handles[i] = INVALID_HANDLE_VALUE;
    target_dir_paths[i] = NULL;
    staged_handles[i] = INVALID_HANDLE_VALUE;
    staged_dir_paths[i] = NULL;
  }

  HANDLE staged_h = INVALID_HANDLE_VALUE;
  HANDLE target_h = INVALID_HANDLE_VALUE;
  HANDLE wal_h = INVALID_HANDLE_VALUE;
  HANDLE shm_h = INVALID_HANDLE_VALUE;
  bool target_locked = false;

  char* target_wal = concat_suffix(target_leaf, "-wal");
  char* target_shm = concat_suffix(target_leaf, "-shm");
  char* target_journal = concat_suffix(target_leaf, "-journal");
  wchar_t* target_full = NULL;
  wchar_t* staged_full = NULL;
  wchar_t* journal_full = NULL;
  wchar_t* wal_full = NULL;
  wchar_t* shm_full = NULL;
  AgyFileRenameInfoEx* rename_info = NULL;
  size_t rename_bytes = 0;

  const char* res_status = "uncertain";
  const char* res_reason = "internal_error";

  if (!target_wal || !target_shm || !target_journal) {
    res_reason = "oom";
    goto cleanup;
  }

  const char* err_code = "EIO";
  const char* err_stage = "open";
  const char* err_msg = "Failed to open anchored directories.";
  if (open_dir_chain_win(
          root_dir, target_segs, target_seg_count, target_handles, target_dir_stats,
          target_dir_paths, &err_code, &err_stage, &err_msg) != 0) {
    res_reason = "target_parent_open_failed";
    goto cleanup;
  }
  if (open_dir_chain_win(
          root_dir, staged_segs, staged_seg_count, staged_handles, staged_dir_stats,
          staged_dir_paths, &err_code, &err_stage, &err_msg) != 0) {
    res_reason = "staged_parent_open_failed";
    goto cleanup;
  }

  if (target_dir_stats[target_seg_count].volume_serial !=
      staged_dir_stats[staged_seg_count].volume_serial) {
    res_status = "exdev";
    res_reason = "exdev";
    goto cleanup;
  }

  const wchar_t* target_parent_path = target_dir_paths[target_seg_count];
  const wchar_t* staged_parent_path = staged_dir_paths[staged_seg_count];

  {
    wchar_t* t_w = utf8_to_wide(target_leaf);
    wchar_t* s_w = utf8_to_wide(staged_leaf);
    wchar_t* j_w = utf8_to_wide(target_journal);
    wchar_t* w_w = utf8_to_wide(target_wal);
    wchar_t* sh_w = utf8_to_wide(target_shm);
    if (t_w) target_full = join_wide_path(target_parent_path, t_w);
    if (s_w) staged_full = join_wide_path(staged_parent_path, s_w);
    if (j_w) journal_full = join_wide_path(target_parent_path, j_w);
    if (w_w) wal_full = join_wide_path(target_parent_path, w_w);
    if (sh_w) shm_full = join_wide_path(target_parent_path, sh_w);
    free(t_w);
    free(s_w);
    free(j_w);
    free(w_w);
    free(sh_w);
  }
  if (!target_full || !staged_full || !journal_full || !wal_full || !shm_full) {
    res_reason = "oom";
    goto cleanup;
  }

  /* Open staged exclusively (GENERIC_READ | DELETE, share 0). */
  staged_h = CreateFileW(
      staged_full, GENERIC_READ | DELETE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  if (staged_h == INVALID_HANDLE_VALUE) {
    res_reason = "staged_open_failed";
    goto cleanup;
  }
  DWORD err = 0;
  AgyFileStat staged_stat;
  if (!query_win_file_stat(staged_h, false, true, &staged_stat, &err) ||
      !file_stat_exact_match(&staged_stat, expected_staged) ||
      !win_handle_still_under_parent(staged_h, staged_parent_path, staged_leaf)) {
    res_reason = "staged_identity_mismatch";
    goto cleanup;
  }

  /* Open target exclusively against readers/writers while permitting POSIX replace via FILE_SHARE_DELETE. */
  target_h = CreateFileW(
      target_full, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (target_h == INVALID_HANDLE_VALUE) {
    res_reason = "target_open_failed";
    goto cleanup;
  }
  OVERLAPPED ov_all;
  memset(&ov_all, 0, sizeof(ov_all));
  ov_all.Offset = SQLITE_PENDING_BYTE;
  if (!LockFileEx(
          target_h,
          LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
          0,
          SQLITE_LOCK_SPAN,
          0,
          &ov_all)) {
    res_reason = "target_lock_contention";
    goto cleanup;
  }
  target_locked = true;

  AgyFileStat target_stat;
  if (!query_win_file_stat(target_h, false, true, &target_stat, &err) ||
      !file_stat_exact_match(&target_stat, expected_target) ||
      !win_handle_still_under_parent(target_h, target_parent_path, target_leaf)) {
    res_reason = "target_identity_mismatch";
    goto cleanup;
  }
  if (file_stat_inode_match(&staged_stat, &target_stat)) {
    res_reason = "same_inode";
    goto cleanup;
  }
  if (!verify_dir_chain_win(
          root_dir, target_segs, target_seg_count, target_handles, target_dir_stats,
          target_dir_paths) ||
      !verify_dir_chain_win(
          root_dir, staged_segs, staged_seg_count, staged_handles, staged_dir_stats,
          staged_dir_paths)) {
    res_reason = "parent_changed";
    goto cleanup;
  }

  /* Reject -journal before deleting any sidefiles. */
  if (win_path_exists_no_reparse(journal_full, NULL, &err) || err != ERROR_SUCCESS) {
    res_reason = "target_journal_present";
    goto cleanup;
  }

  /* Verify -wal is absent or ordinary single-link 0-byte non-reparse file. */
  wal_h = CreateFileW(
      wal_full, DELETE | FILE_READ_ATTRIBUTES, 0, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  if (wal_h == INVALID_HANDLE_VALUE) {
    DWORD we = GetLastError();
    if (we != ERROR_FILE_NOT_FOUND && we != ERROR_PATH_NOT_FOUND) {
      res_reason = "target_wal_open_failed";
      goto cleanup;
    }
  } else {
    AgyFileStat wal_stat;
    if (!query_win_file_stat(wal_h, false, true, &wal_stat, &err) || wal_stat.size != 0 ||
        !win_handle_still_under_parent(wal_h, target_parent_path, target_wal)) {
      res_reason = "target_wal_nonempty_or_linked";
      goto cleanup;
    }
  }

  /* Verify -shm is absent or ordinary single-link non-reparse file BEFORE deleting -wal or -shm. */
  shm_h = CreateFileW(
      shm_full, DELETE | FILE_READ_ATTRIBUTES, 0, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT,
      NULL);
  if (shm_h == INVALID_HANDLE_VALUE) {
    DWORD se = GetLastError();
    if (se != ERROR_FILE_NOT_FOUND && se != ERROR_PATH_NOT_FOUND) {
      res_reason = "target_shm_open_failed";
      goto cleanup;
    }
  } else {
    AgyFileStat shm_stat;
    if (!query_win_file_stat(shm_h, false, true, &shm_stat, &err) ||
        !win_handle_still_under_parent(shm_h, target_parent_path, target_shm)) {
      res_reason = "target_shm_invalid";
      goto cleanup;
    }
  }

  /* Reject standalone -shm (has_shm && !has_wal) BEFORE any unlink! */
  if (shm_h != INVALID_HANDLE_VALUE && wal_h == INVALID_HANDLE_VALUE) {
    res_reason = "standalone_shm";
    goto cleanup;
  }

  /* Allocate and prepare rename buffer BEFORE deleting any sidefile. */
  {
    size_t name_chars = wcslen(target_full);
    rename_bytes = offsetof(AgyFileRenameInfoEx, FileName) + (name_chars + 1) * sizeof(WCHAR);
    rename_info = (AgyFileRenameInfoEx*)calloc(1, rename_bytes);
    if (!rename_info) {
      res_reason = "oom";
      goto cleanup;
    }
    rename_info->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
    rename_info->RootDirectory = NULL;
    rename_info->FileNameLength = (DWORD)(name_chars * sizeof(WCHAR));
    memcpy(rename_info->FileName, target_full, (name_chars + 1) * sizeof(WCHAR));
  }

  /* Delete verified 0-byte -wal and verified -shm via FileDispositionInfo. */
  if (wal_h != INVALID_HANDLE_VALUE) {
    FILE_DISPOSITION_INFO disp;
    disp.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(wal_h, FileDispositionInfo, &disp, sizeof(disp))) {
      res_reason = "target_wal_unlink_failed";
      goto cleanup;
    }
    CloseHandle(wal_h);
    wal_h = INVALID_HANDLE_VALUE;
  }
  if (shm_h != INVALID_HANDLE_VALUE) {
    FILE_DISPOSITION_INFO disp;
    disp.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(shm_h, FileDispositionInfo, &disp, sizeof(disp))) {
      res_reason = "target_shm_unlink_failed";
      goto cleanup;
    }
    CloseHandle(shm_h);
    shm_h = INVALID_HANDLE_VALUE;
  }

  /* Replace target atomically with staged via FileRenameInfoEx + POSIX semantics. */
  if (!SetFileInformationByHandle(
          staged_h, AGY_FILE_RENAME_INFO_EX_CLASS, rename_info, (DWORD)rename_bytes)) {
    DWORD re = GetLastError();
    if (re == ERROR_NOT_SAME_DEVICE) {
      res_status = "exdev";
      res_reason = "exdev";
    } else {
      res_reason = "rename_failed";
    }
    goto cleanup;
  }

  res_status = "published";
  res_reason = NULL;

cleanup:
  free(rename_info);
  if (shm_h != INVALID_HANDLE_VALUE) CloseHandle(shm_h);
  if (wal_h != INVALID_HANDLE_VALUE) CloseHandle(wal_h);
  if (target_locked && target_h != INVALID_HANDLE_VALUE) {
    OVERLAPPED ov_u;
    memset(&ov_u, 0, sizeof(ov_u));
    ov_u.Offset = SQLITE_PENDING_BYTE;
    (void)UnlockFileEx(target_h, 0, SQLITE_LOCK_SPAN, 0, &ov_u);
  }
  if (staged_h != INVALID_HANDLE_VALUE) CloseHandle(staged_h);
  if (target_h != INVALID_HANDLE_VALUE) CloseHandle(target_h);
  close_dir_chain_win(target_handles, target_dir_paths, target_seg_count);
  close_dir_chain_win(staged_handles, staged_dir_paths, staged_seg_count);
  free(target_full);
  free(staged_full);
  free(journal_full);
  free(wal_full);
  free(shm_full);
  free(target_wal);
  free(target_shm);
  free(target_journal);
  return create_publish_result(env, res_status, res_reason);
}

#endif

/* ============================================================================
 * N-API Bound Methods & Exported Functions
 * ============================================================================ */

static void view_finalize_cb(napi_env env, void* finalize_data, void* finalize_hint) {
  (void)env;
  (void)finalize_hint;
  view_destroy((AgyLockedView*)finalize_data);
}

static AgyLockedView* parse_path_args(
    napi_env env, napi_value root_arg, napi_value segs_arg, napi_value leaf_arg) {
  char* root_dir = dup_js_string(env, root_arg, AGY_MAX_PATH_BYTES);
  if (!root_dir) {
    napi_throw_type_error(env, "EINVAL", "rootDir must be a non-empty string.");
    return NULL;
  }
  bool is_arr = false;
  if (napi_is_array(env, segs_arg, &is_arr) != napi_ok || !is_arr) {
    free(root_dir);
    napi_throw_type_error(env, "EINVAL", "parentSegments must be an array of strings.");
    return NULL;
  }
  uint32_t seg_count = 0;
  if (napi_get_array_length(env, segs_arg, &seg_count) != napi_ok ||
      seg_count > AGY_MAX_PARENT_SEGMENTS) {
    free(root_dir);
    napi_throw_type_error(env, "EINVAL", "parentSegments exceeds maximum depth.");
    return NULL;
  }
  char* leaf_name = dup_js_string(env, leaf_arg, AGY_MAX_NAME_BYTES);
  if (!leaf_name || !is_valid_segment(leaf_name)) {
    free(root_dir);
    free(leaf_name);
    napi_throw_type_error(env, "EINVAL", "leafName must be a safe single filename.");
    return NULL;
  }

  AgyLockedView* v = (AgyLockedView*)calloc(1, sizeof(AgyLockedView));
  if (!v) {
    free(root_dir);
    free(leaf_name);
    throw_coded_error(env, "ENOMEM", "open", "Out of memory allocating view.");
    return NULL;
  }
  v->root_dir = root_dir;
  v->leaf_name = leaf_name;
  v->wal_name = concat_suffix(leaf_name, "-wal");
  v->shm_name = concat_suffix(leaf_name, "-shm");
  v->journal_name = concat_suffix(leaf_name, "-journal");
  if (!v->wal_name || !v->shm_name || !v->journal_name) {
    v->closed = true;
    view_destroy(v);
    throw_coded_error(env, "ENOMEM", "open", "Out of memory allocating sidefile names.");
    return NULL;
  }

  for (uint32_t i = 0; i < seg_count; i++) {
    napi_value el = NULL;
    if (napi_get_element(env, segs_arg, i, &el) != napi_ok) {
      v->closed = true;
      view_destroy(v);
      napi_throw_type_error(env, "EINVAL", "Failed to read parentSegments element.");
      return NULL;
    }
    char* seg = dup_js_string(env, el, AGY_MAX_NAME_BYTES);
    if (!seg || !is_valid_segment(seg)) {
      free(seg);
      v->closed = true;
      view_destroy(v);
      napi_throw_type_error(env, "EINVAL", "Each parent segment must be a safe single name.");
      return NULL;
    }
    v->segments[i] = seg;
    v->segment_count = (size_t)(i + 1);
  }
  return v;
}

static AgyLockedView* unwrap_view(napi_env env, napi_callback_info info, napi_value* argv, size_t* argc) {
  napi_value self = NULL;
  if (napi_get_cb_info(env, info, argc, argv, &self, NULL) != napi_ok) return NULL;
  void* raw = NULL;
  if (napi_unwrap(env, self, &raw) != napi_ok || !raw) {
    throw_coded_error(env, "EINVAL", "handle", "Invalid AgyLockedSqliteView receiver.");
    return NULL;
  }
  return (AgyLockedView*)raw;
}

static napi_value js_read_target(napi_env env, napi_callback_info info, int which) {
  napi_value argv[2];
  size_t argc = 2;
  AgyLockedView* v = unwrap_view(env, info, argv, &argc);
  if (!v) return NULL;
  if (v->closed) {
    return throw_coded_error(env, "EBADF", "read", "AgyLockedSqliteView is already closed.");
  }
  if (argc < 2) {
    napi_throw_type_error(env, "EINVAL", "Expected (offset, length).");
    return NULL;
  }
  int64_t offset = 0;
  int64_t length = 0;
  if (!read_nonneg_safe_int(env, argv[0], &offset) ||
      !read_nonneg_safe_int(env, argv[1], &length)) {
    napi_throw_type_error(
        env, "EINVAL", "offset and length must be finite non-negative safe integers.");
    return NULL;
  }
  if (offset > INT64_MAX - length) {
    return throw_coded_error(
        env, "EINVAL", "read", "offset + length overflows representable 64-bit range.");
  }
#if !defined(_WIN32)
  int fd = (which == 0) ? v->db_fd : (which == 1 ? v->wal_fd : v->shm_fd);
  if (fd < 0) {
    return throw_coded_error(env, "ENOENT", "read", "Requested SQLite stream is not open.");
  }
  return view_read_fd(env, fd, offset, length);
#else
  HANDLE h = (which == 0) ? v->db_handle : (which == 1 ? v->wal_handle : v->shm_handle);
  if (h == INVALID_HANDLE_VALUE) {
    return throw_coded_error(env, "ENOENT", "read", "Requested SQLite stream is not open.");
  }
  return view_read_handle(env, h, offset, length);
#endif
}

static napi_value js_read_at(napi_env env, napi_callback_info info) {
  return js_read_target(env, info, 0);
}

static napi_value js_read_wal_at(napi_env env, napi_callback_info info) {
  return js_read_target(env, info, 1);
}

static napi_value js_read_shm_at(napi_env env, napi_callback_info info) {
  return js_read_target(env, info, 2);
}

static napi_value js_verify_unchanged(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  AgyLockedView* v = unwrap_view(env, info, NULL, &argc);
  if (!v) return NULL;
  const char* reason = view_verify_unchanged_impl(v);
  napi_value out = NULL;
  if (napi_create_object(env, &out) != napi_ok) return NULL;
  set_bool_prop(env, out, "unchanged", reason == NULL);
  if (reason != NULL) {
    set_str_prop(env, out, "reason", reason);
  }
  return out;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  AgyLockedView* v = unwrap_view(env, info, NULL, &argc);
  if (!v) return NULL;
  view_close_handles(v);
  napi_value undef = NULL;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value js_open_anchored_locked_view(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    napi_throw_type_error(
        env, "EINVAL", "Expected (rootDir, parentSegments, leafName, [options]).");
    return NULL;
  }
  napi_value opts = argc >= 4 ? argv[3] : NULL;
  bool acquire_lock = get_opt_bool(env, opts, "acquireSharedLock", true);
  bool open_wal = get_opt_bool(env, opts, "openWal", true);
  bool open_shm = get_opt_bool(env, opts, "openShm", true);
  bool check_journal = get_opt_bool(env, opts, "checkJournal", true);

  AgyLockedView* v = parse_path_args(env, argv[0], argv[1], argv[2]);
  if (!v) return NULL;

  if (!open_anchored_view_platform(env, v, acquire_lock, open_wal, open_shm, check_journal)) {
    return NULL;
  }
  napi_value obj = NULL;
  if (napi_create_object(env, &obj) != napi_ok) {
    view_destroy(v);
    return NULL;
  }
  if (napi_wrap(env, obj, v, view_finalize_cb, NULL, NULL) != napi_ok) {
    view_destroy(v);
    return NULL;
  }
  set_double_prop(env, obj, "byteLength", (double)v->db_stat.size);
  set_double_prop(env, obj, "walByteLength", v->has_wal ? (double)v->wal_stat.size : 0.0);
  set_double_prop(env, obj, "shmByteLength", v->has_shm ? (double)v->shm_stat.size : 0.0);
  set_bool_prop(env, obj, "hasWal", v->has_wal);
  set_bool_prop(env, obj, "hasShm", v->has_shm);
  set_bool_prop(env, obj, "hasJournal", v->has_journal);
  set_bool_prop(env, obj, "sharedLockHeld", v->shared_lock_held);

  napi_value db_id = create_identity_object(env, &v->db_stat);
  if (db_id) napi_set_named_property(env, obj, "fileIdentity", db_id);
  napi_value null_val = NULL;
  napi_get_null(env, &null_val);
  if (v->has_wal) {
    napi_value wal_id = create_identity_object(env, &v->wal_stat);
    if (wal_id) napi_set_named_property(env, obj, "walIdentity", wal_id);
  } else if (null_val) {
    napi_set_named_property(env, obj, "walIdentity", null_val);
  }
  if (v->has_shm) {
    napi_value shm_id = create_identity_object(env, &v->shm_stat);
    if (shm_id) napi_set_named_property(env, obj, "shmIdentity", shm_id);
  } else if (null_val) {
    napi_set_named_property(env, obj, "shmIdentity", null_val);
  }

  set_fn_prop(env, obj, "readAt", js_read_at, NULL);
  set_fn_prop(env, obj, "readWalAt", js_read_wal_at, NULL);
  set_fn_prop(env, obj, "readShmAt", js_read_shm_at, NULL);
  set_fn_prop(env, obj, "verifyUnchanged", js_verify_unchanged, NULL);
  set_fn_prop(env, obj, "close", js_close, NULL);
  return obj;
}

static napi_value js_verify_candidate_empty_unlocked(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    napi_throw_type_error(env, "EINVAL", "Expected (rootDir, parentSegments, leafName).");
    return NULL;
  }
  AgyLockedView* v = parse_path_args(env, argv[0], argv[1], argv[2]);
  if (!v) return NULL;
  return verify_candidate_platform(env, v);
}

static napi_value js_check_same_volume(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 3) {
    napi_throw_type_error(
        env, "EINVAL", "Expected (rootDir, leftParentSegments, rightParentSegments).");
    return NULL;
  }
  char* root_dir = dup_js_string(env, argv[0], AGY_MAX_PATH_BYTES);
  if (!root_dir) {
    napi_throw_type_error(env, "EINVAL", "rootDir must be a non-empty string.");
    return NULL;
  }
  char* left_segs[AGY_MAX_PARENT_SEGMENTS];
  size_t left_count = 0;
  if (!parse_segments_array(env, argv[1], left_segs, &left_count)) {
    free(root_dir);
    return NULL;
  }
  char* right_segs[AGY_MAX_PARENT_SEGMENTS];
  size_t right_count = 0;
  if (!parse_segments_array(env, argv[2], right_segs, &right_count)) {
    for (size_t i = 0; i < left_count; i++) free(left_segs[i]);
    free(root_dir);
    return NULL;
  }
  napi_value res =
      check_same_volume_platform(env, root_dir, left_segs, left_count, right_segs, right_count);
  for (size_t i = 0; i < left_count; i++) free(left_segs[i]);
  for (size_t i = 0; i < right_count; i++) free(right_segs[i]);
  free(root_dir);
  return res;
}

static napi_value js_publish_candidate_atomically(napi_env env, napi_callback_info info) {
  napi_value argv[7];
  size_t argc = 7;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 7) {
    napi_throw_type_error(
        env,
        "EINVAL",
        "Expected (rootDir, targetSegs, targetLeaf, stagedSegs, stagedLeaf, expectedTargetId, "
        "expectedStagedId).");
    return NULL;
  }
  char* root_dir = dup_js_string(env, argv[0], AGY_MAX_PATH_BYTES);
  if (!root_dir) {
    napi_throw_type_error(env, "EINVAL", "rootDir must be a non-empty string.");
    return NULL;
  }
  char* target_segs[AGY_MAX_PARENT_SEGMENTS];
  size_t target_seg_count = 0;
  if (!parse_segments_array(env, argv[1], target_segs, &target_seg_count)) {
    free(root_dir);
    return NULL;
  }
  char* target_leaf = dup_js_string(env, argv[2], AGY_MAX_NAME_BYTES);
  if (!target_leaf || !is_valid_segment(target_leaf)) {
    free(target_leaf);
    for (size_t i = 0; i < target_seg_count; i++) free(target_segs[i]);
    free(root_dir);
    napi_throw_type_error(env, "EINVAL", "targetLeafName must be a safe single filename.");
    return NULL;
  }
  char* staged_segs[AGY_MAX_PARENT_SEGMENTS];
  size_t staged_seg_count = 0;
  if (!parse_segments_array(env, argv[3], staged_segs, &staged_seg_count)) {
    free(target_leaf);
    for (size_t i = 0; i < target_seg_count; i++) free(target_segs[i]);
    free(root_dir);
    return NULL;
  }
  char* staged_leaf = dup_js_string(env, argv[4], AGY_MAX_NAME_BYTES);
  if (!staged_leaf || !is_valid_segment(staged_leaf)) {
    free(staged_leaf);
    for (size_t i = 0; i < staged_seg_count; i++) free(staged_segs[i]);
    free(target_leaf);
    for (size_t i = 0; i < target_seg_count; i++) free(target_segs[i]);
    free(root_dir);
    napi_throw_type_error(env, "EINVAL", "stagedLeafName must be a safe single filename.");
    return NULL;
  }
  AgyFileStat expected_target;
  AgyFileStat expected_staged;
  memset(&expected_target, 0, sizeof(expected_target));
  memset(&expected_staged, 0, sizeof(expected_staged));
  if (!parse_identity_arg(env, argv[5], &expected_target) ||
      !parse_identity_arg(env, argv[6], &expected_staged)) {
    free(staged_leaf);
    for (size_t i = 0; i < staged_seg_count; i++) free(staged_segs[i]);
    free(target_leaf);
    for (size_t i = 0; i < target_seg_count; i++) free(target_segs[i]);
    free(root_dir);
    napi_throw_type_error(
        env, "EINVAL", "expectedTargetIdentity and expectedStagedIdentity must be valid.");
    return NULL;
  }

  napi_value res = publish_candidate_atomically_platform(
      env,
      root_dir,
      target_segs,
      target_seg_count,
      target_leaf,
      staged_segs,
      staged_seg_count,
      staged_leaf,
      &expected_target,
      &expected_staged);
  free(staged_leaf);
  for (size_t i = 0; i < staged_seg_count; i++) free(staged_segs[i]);
  free(target_leaf);
  for (size_t i = 0; i < target_seg_count; i++) free(target_segs[i]);
  free(root_dir);
  return res;
}

static napi_value js_module_identity(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value obj = NULL;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  set_double_prop(env, obj, "version", 1.0);
  set_str_prop(env, obj, "platform", AGY_PLATFORM);
  set_str_prop(env, obj, "architecture", AGY_ARCH);
  set_str_prop(env, obj, "sourceSha256", PACT_AGY_SQLITE_FILE_SOURCE_SHA256);
  return obj;
}

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
#if defined(_WIN32)
  if (!agy_init_napi_table()) return NULL;
#endif
  set_fn_prop(env, exports, "moduleIdentity", js_module_identity, NULL);
  set_fn_prop(env, exports, "openAnchoredLockedView", js_open_anchored_locked_view, NULL);
  set_fn_prop(
      env, exports, "verifyCandidateEmptyUnlocked", js_verify_candidate_empty_unlocked, NULL);
  set_fn_prop(env, exports, "publishCandidateAtomically", js_publish_candidate_atomically, NULL);
  set_fn_prop(env, exports, "checkSameVolume", js_check_same_volume, NULL);
  return exports;
}
