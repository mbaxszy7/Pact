#include <Security/Security.h>
#include <limits.h>
#include <node_api.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

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

static napi_value reject(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static napi_value initialize(napi_env env, napi_value exports) {
  Boolean allowed = true;
  OSStatus result = SecKeychainSetUserInteractionAllowed(false);
  if (result == errSecSuccess) result = SecKeychainGetUserInteractionAllowed(&allowed);
  if (result != errSecSuccess || allowed)
    return reject(env, "KEYCHAIN_INTERACTION", "Noninteractive Keychain guard failed.");
  char home[PATH_MAX], expected[PATH_MAX], actual[PATH_MAX], variant[PATH_MAX];
  const char *requested = getenv("HOME");
  struct passwd *account = getpwuid(getuid());
  const char *slash;
  if (!requested || strlen(requested) > PATH_MAX - 128 || !account ||
      !realpath(requested, home) || strcmp(home, requested) ||
      !strcmp(home, account->pw_dir) ||
      strlen(home) <= 5 || strcmp(home + strlen(home) - 5, "/home") ||
      !directory(home))
    return reject(env, "KEYCHAIN_SCOPE", "Owned Keychain scope required.");
  slash = home + strlen(home) - 5;
  {
    const char *end = slash;
    const char *start = end;
    while (start > home && start[-1] != '/') start--;
    if ((size_t)(end - start) < strlen("pact-runtime-e2e-") ||
        strncmp(start, "pact-runtime-e2e-", strlen("pact-runtime-e2e-")))
      return reject(env, "KEYCHAIN_SCOPE", "Owned Keychain scope required.");
  }
  snprintf(expected, sizeof(expected), "%s/Library/Keychains", home);
  if (!directory(expected))
    return reject(env, "KEYCHAIN_SCOPE", "Owned Keychain scope required.");
  snprintf(expected, sizeof(expected), "%s/Library/Keychains/relay-fixture.keychain", home);
  snprintf(variant, sizeof(variant), "%s/Library/Keychains/relay-fixture.keychain-db", home);
  /* Canonical owned keychain target BEFORE GetStatus/encryption calls. */
  {
    struct stat st;
    int present = lstat(expected, &st) == 0, variantPresent = lstat(variant, &st) == 0;
    if ((!present && !variantPresent) ||
        (present && !ownedFile(expected, expected)) ||
        (variantPresent && !ownedFile(variant, variant)))
      return reject(env, "KEYCHAIN_UNAVAILABLE", "Owned Keychain is unavailable.");
  }
  SecKeychainRef keychain = NULL;
  result = SecKeychainCopyDefault(&keychain);
  UInt32 length = sizeof(actual);
  SecKeychainStatus flags = 0;
  if (result == errSecSuccess) result = SecKeychainGetPath(keychain, &length, actual);
  if (keychain && result == errSecSuccess && length < sizeof(actual)) {
    /* The default's canonical owned target is confirmed BEFORE its status. */
    actual[length] = '\0';
    if (strncmp(actual, expected, strlen(expected)) ||
        (strcmp(actual + strlen(expected), "") && strcmp(actual + strlen(expected), "-db")))
      result = (OSStatus)-1;
  }
  if (result == errSecSuccess) result = SecKeychainGetStatus(keychain, &flags);
  if (keychain) CFRelease(keychain);
  if (result != errSecSuccess || length >= sizeof(actual) ||
      !(flags & kSecUnlockStateStatus))
    return reject(env, "KEYCHAIN_UNAVAILABLE", "Owned Keychain is unavailable.");
  napi_value yes;
  if (napi_get_boolean(env, true, &yes) != napi_ok ||
      napi_set_named_property(env, exports, "guarded", yes) != napi_ok)
    return reject(env, "KEYCHAIN_GUARD_EXPORT", "Keychain guard result unavailable.");
  return exports;
}

NAPI_MODULE(pact_keychain_no_ui, initialize)
