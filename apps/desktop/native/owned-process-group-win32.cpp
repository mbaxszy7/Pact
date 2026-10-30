// First-party process ownership bridge. Build only with the target Windows SDK/MSVC.
// Control uses inherited CRT fd 3; the private receipt uses fd 4. Neither is
// inherited by the target. Target stdin/stdout/stderr never carry control facts.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <string_view>

#ifndef PACT_OWNER_SOURCE_SHA256
#error The build must bind this executable to its source SHA256.
#endif

namespace {
constexpr DWORD kProtocol = 1, kFrameBytes = 128 * 1024, kReceiptBytes = 256;
constexpr ULONGLONG kPrepareMs = 15000, kCleanupMs = 4000, kGraceMs = 250;
constexpr DWORD kReceiptFlags = 31; // atomic, no-breakaway, closed gate, root signaled, job empty
struct Failure { DWORD code; };
[[noreturn]] void fail(DWORD code = ERROR_INVALID_DATA) { throw Failure{code}; }
void check(BOOL success) { if (!success) fail(GetLastError()); }
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  ~Handle() { close(); }
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
  void set(HANDLE h) { close(); value = h; }
};
struct Birth { DWORD pid = 0; ULONGLONG time = 0; };
struct FileIdentity { ULONGLONG volume = 0; std::array<BYTE, 16> id{}; };
// Explicit native workspace: < 300 KiB. No output capture, task queue or heap arena.
struct Workspace {
  std::array<BYTE, kFrameBytes> frame{};
  std::array<WCHAR, 32768> command{};
  std::array<WCHAR, 32768> path{};
  alignas(void*) std::array<BYTE, 4096> attributes{};
  std::array<BYTE, kReceiptBytes> receipt{};
} workspace;
static_assert(sizeof(Workspace) < 300 * 1024);

struct Reader {
  const BYTE* at; size_t remaining;
  void take(void* into, size_t bytes) {
    if (bytes > remaining) fail();
    memcpy(into, at, bytes); at += bytes; remaining -= bytes;
  }
  BYTE byte() { BYTE value; take(&value, 1); return value; }
  DWORD u32() { DWORD value; take(&value, 4); return value; }
  ULONGLONG u64() { ULONGLONG value; take(&value, 8); return value; }
  Birth birth() { return Birth{u32(), u64()}; }
  std::wstring_view text() {
    DWORD units = u32();
    if (reinterpret_cast<uintptr_t>(at) & 1) { if (byte()) fail(); }
    if (units > 32767 || size_t(units) * 2 > remaining) fail();
    // Frames use explicit little-endian UTF-16. Copy text before passing to Win32.
    auto result = std::wstring_view(reinterpret_cast<const WCHAR*>(at), units);
    for (WCHAR c : result) if (!c) fail();
    at += size_t(units) * 2; remaining -= size_t(units) * 2;
    return result;
  }
  void end() const { if (remaining) fail(); }
};
struct Writer {
  BYTE* base; DWORD size = 0, capacity;
  void put(const void* data, DWORD bytes) {
    if (bytes > capacity - size) fail();
    memcpy(base + size, data, bytes); size += bytes;
  }
  void byte(BYTE value) { put(&value, 1); }
  void u32(DWORD value) { put(&value, 4); }
  void u64(ULONGLONG value) { put(&value, 8); }
  void birth(Birth value) { u32(value.pid); u64(value.time); }
};
Birth identity(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  check(GetProcessTimes(process, &created, &exited, &kernel, &user));
  DWORD pid = GetProcessId(process);
  if (!pid || pid > 0x7fffffff) fail();
  return Birth{pid, (ULONGLONG(created.dwHighDateTime) << 32) | created.dwLowDateTime};
}
bool same(Birth a, Birth b) { return a.pid == b.pid && a.time == b.time; }
bool same(FileIdentity a, FileIdentity b) { return a.volume == b.volume && a.id == b.id; }
FileIdentity fileIdentity(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION basic{};
  FILE_ID_INFO identity{};
  check(GetFileInformationByHandle(file, &basic));
  check(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)));
  if (GetFileType(file) != FILE_TYPE_DISK || basic.nNumberOfLinks != 1 ||
      (basic.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) fail();
  FileIdentity result{identity.VolumeSerialNumber};
  memcpy(result.id.data(), identity.FileId.Identifier, result.id.size());
  return result;
}
DWORD crc(const BYTE* data, DWORD bytes) {
  DWORD result = 0xffffffff;
  for (DWORD index = 0; index < bytes; ++index) {
    result ^= data[index];
    for (int bit = 0; bit < 8; ++bit)
      result = (result >> 1) ^ (0xedb88320 & (0 - (result & 1)));
  }
  return ~result;
}
// Keep every directory and the leaf pinned against rename until this mode exits.
// Reject redirected/network paths and every reparse component; no path-following fallback.
struct PinnedFile {
  std::array<Handle, 256> components;
  HANDLE leaf = nullptr;
  bool missing = false;
  FileIdentity identity;
  void pin(std::wstring_view requested, bool retire = false) {
    if (requested.size() < 4 || requested.size() >= workspace.path.size() ||
        requested[1] != L':' || requested[2] != L'\\' ||
        !((requested[0] >= L'A' && requested[0] <= L'Z') ||
          (requested[0] >= L'a' && requested[0] <= L'z'))) fail();
    WCHAR drive[] = {requested[0], L':', L'\\', 0};
    const UINT driveType = GetDriveTypeW(drive);
    if (driveType != DRIVE_FIXED && driveType != DRIVE_RAMDISK) fail();
    std::copy(requested.begin(), requested.end(), workspace.path.begin());
    workspace.path[requested.size()] = 0;
    size_t count = 0, start = 3;
    for (size_t index = 3; index <= requested.size(); ++index) {
      if (index != requested.size() && workspace.path[index] != L'\\') continue;
      const size_t length = index - start;
      if (!length || (length == 1 && workspace.path[start] == L'.') ||
          (length == 2 && workspace.path[start] == L'.' && workspace.path[start + 1] == L'.') ||
          count == components.size()) fail();
      WCHAR saved = workspace.path[index]; workspace.path[index] = 0;
      HANDLE handle = CreateFileW(workspace.path.data(), FILE_READ_ATTRIBUTES |
          (retire && index == requested.size() ? DELETE : 0),
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
      workspace.path[index] = saved;
      if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        // Every parent was opened without reparse traversal and is still pinned.
        // Only absence of this final known receipt name can acknowledge a prior
        // committed retirement whose database ACK was lost.
        if (retire && index == requested.size() && count > 0 && error == ERROR_FILE_NOT_FOUND) {
          missing = true; return;
        }
        fail(error);
      }
      components[count++].set(handle);
      if (index == requested.size()) leaf = handle;
      FILE_ATTRIBUTE_TAG_INFO info{};
      check(GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)));
      if (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) fail();
      if (index < requested.size() && !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) fail();
      start = index + 1;
    }
    if (!count) fail();
    identity = fileIdentity(components[count - 1].value);
  }
  void validate(HANDLE inherited, std::wstring_view requested) {
    pin(requested);
    if (!same(identity, fileIdentity(inherited))) fail();
  }
};
struct Control {
  HANDLE pipe;
  bool broken = false;
  bool available(DWORD* count = nullptr) {
    DWORD bytes = 0;
    if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &bytes, nullptr)) {
      broken = true; return false;
    }
    if (count) *count = bytes;
    return bytes != 0;
  }
  void readExact(void* output, DWORD bytes, ULONGLONG deadline, HANDLE owner = nullptr) {
    DWORD offset = 0;
    while (offset < bytes) {
      if (GetTickCount64() >= deadline ||
          (owner && WaitForSingleObject(owner, 0) != WAIT_TIMEOUT)) fail(ERROR_TIMEOUT);
      DWORD buffered = 0;
      if (!available(&buffered)) { if (broken) fail(ERROR_BROKEN_PIPE); Sleep(5); continue; }
      DWORD received = 0;
      check(ReadFile(pipe, static_cast<BYTE*>(output) + offset, std::min(bytes - offset, buffered), &received, nullptr));
      if (!received) fail(ERROR_BROKEN_PIPE);
      offset += received;
    }
  }
  Reader read(ULONGLONG deadline, HANDLE owner = nullptr) {
    DWORD bytes = 0; readExact(&bytes, 4, deadline, owner);
    if (!bytes || bytes > workspace.frame.size()) fail();
    readExact(workspace.frame.data(), bytes, deadline, owner);
    return Reader{workspace.frame.data(), bytes};
  }
  bool emit(const Writer& message) {
    if (broken) return false;
    DWORD sent = 0;
    if (!WriteFile(pipe, &message.size, 4, &sent, nullptr) || sent != 4 ||
        !WriteFile(pipe, message.base, message.size, &sent, nullptr) || sent != message.size) {
      broken = true; return false;
    }
    return true;
  }
  void error(DWORD code) {
    BYTE bytes[5]; Writer message{bytes, 0, sizeof(bytes)};
    message.byte(16); message.u32(code); emit(message);
  }
};
struct Request {
  Birth owner;
  std::array<BYTE, 16> ownerId{}, generation{}, receiptId{};
  std::wstring_view path;
  FileIdentity file;
  void base(Reader& reader) {
    if (reader.byte() != kProtocol) fail();
    owner.pid = reader.u32();
    if (!owner.pid || owner.pid > 0x7fffffff) fail();
    reader.take(ownerId.data(), 16); reader.take(generation.data(), 16);
    reader.take(receiptId.data(), 16); path = reader.text();
  }
  void bound(Reader& reader) {
    owner.time = reader.u64(); file.volume = reader.u64(); reader.take(file.id.data(), 16);
    if (!owner.time) fail();
  }
};
void openOwner(Handle& handle, Birth expected, bool checkBirth) {
  handle.set(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, expected.pid));
  if (!handle.value) fail(GetLastError());
  check(SetHandleInformation(handle.value, HANDLE_FLAG_INHERIT, 0));
  if (WaitForSingleObject(handle.value, 0) != WAIT_TIMEOUT ||
      (checkBirth && !same(identity(handle.value), expected))) fail();
}
void prepare(Control& control, HANDLE receipt, Reader& reader) {
  Request request; request.base(reader); reader.end();
  PinnedFile file; file.validate(receipt, request.path);
  LARGE_INTEGER size{}; check(GetFileSizeEx(receipt, &size));
  if (size.QuadPart != 0) fail();
  Handle owner; openOwner(owner, request.owner, false);
  BYTE bytes[37]; Writer reply{bytes, 0, sizeof(bytes)};
  reply.byte(11); reply.birth(identity(owner.value));
  reply.u64(file.identity.volume); reply.put(file.identity.id.data(), 16);
  if (!control.emit(reply)) fail(ERROR_BROKEN_PIPE);
}
DWORD active(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr));
  return info.ActiveProcesses;
}
void append(std::wstring_view text, size_t& length) {
  if (text.size() >= workspace.command.size() - length) fail(ERROR_BUFFER_OVERFLOW);
  std::copy(text.begin(), text.end(), workspace.command.begin() + length); length += text.size();
}
void quote(std::wstring_view argument, size_t& length) {
  append(L"\"", length); size_t slashes = 0;
  for (WCHAR c : argument) {
    if (c == L'\\') { ++slashes; continue; }
    for (size_t index = 0; index < slashes * (c == L'\"' ? 2 : 1); ++index) append(L"\\", length);
    if (c == L'\"') append(L"\\", length);
    append(std::wstring_view(&c, 1), length); slashes = 0;
  }
  for (size_t index = 0; index < slashes * 2; ++index) append(L"\\", length);
  append(L"\"", length);
}
void seal(HANDLE file, const Request& request, Birth bridge, Birth root, DWORD exitCode) {
  workspace.receipt.fill(0);
  Writer record{workspace.receipt.data(), 0, kReceiptBytes};
  record.put("PACTOWN1", 8); record.u32(kProtocol); record.u32(kReceiptBytes);
  record.put(request.ownerId.data(), 16); record.put(request.generation.data(), 16);
  record.put(request.receiptId.data(), 16); record.u64(request.file.volume);
  record.put(request.file.id.data(), 16); record.birth(request.owner);
  record.birth(bridge); record.birth(root); record.u32(kReceiptFlags); record.u32(exitCode);
  const DWORD checksum = crc(workspace.receipt.data(), kReceiptBytes - 4);
  memcpy(workspace.receipt.data() + kReceiptBytes - 4, &checksum, 4);
  LARGE_INTEGER zero{}; check(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN));
  DWORD written = 0; check(WriteFile(file, workspace.receipt.data(), kReceiptBytes, &written, nullptr));
  if (written != kReceiptBytes) fail(ERROR_WRITE_FAULT);
  check(SetEndOfFile(file)); check(FlushFileBuffers(file));
}
DWORD run(Control& control, HANDLE receipt, Reader& reader, ULONGLONG initialDeadline) {
  Request request; request.base(reader); request.bound(reader);
  const ULONGLONG lifetimeAt = reader.u64(), preparationAt = reader.u64();
  const BYTE verbatim = reader.byte();
  FILETIME systemTime{}; GetSystemTimeAsFileTime(&systemTime);
  const ULONGLONG epochMs = ((ULONGLONG(systemTime.dwHighDateTime) << 32) | systemTime.dwLowDateTime) / 10000 - 11644473600000ULL;
  if (preparationAt <= epochMs || preparationAt - epochMs > kPrepareMs ||
      (lifetimeAt && (lifetimeAt <= epochMs || lifetimeAt - epochMs > kPrepareMs)) || verbatim > 1) fail();
  const ULONGLONG now = GetTickCount64();
  const ULONGLONG prepDeadline = std::min(initialDeadline, now + preparationAt - epochMs);
  const ULONGLONG lifetimeDeadline = lifetimeAt ? now + lifetimeAt - epochMs : ~ULONGLONG(0);
  Handle owner; openOwner(owner, request.owner, true);
  PinnedFile file; file.validate(receipt, request.path);
  if (!same(file.identity, request.file)) fail();
  auto executable = reader.text();
  if (executable.empty() || executable.size() >= workspace.path.size()) fail();
  std::copy(executable.begin(), executable.end(), workspace.path.begin());
  workspace.path[executable.size()] = 0;
  // SDKs may request "node". Resolve that target once using its inherited search
  // environment, then supply an explicit lpApplicationName. The bridge itself
  // always has a fixed application resource path; neither launch uses a shell.
  DWORD resolved = SearchPathW(nullptr, workspace.path.data(), L".exe",
      static_cast<DWORD>(workspace.command.size()), workspace.command.data(), nullptr);
  if (!resolved || resolved >= workspace.command.size()) fail();
  std::copy_n(workspace.command.begin(), resolved + 1, workspace.path.begin());
  size_t length = 0; quote(std::wstring_view(workspace.path.data(), resolved), length);
  DWORD argc = reader.u32(); if (argc > 4096) fail();
  for (DWORD index = 0; index < argc; ++index) {
    auto argument = reader.text(); append(L" ", length);
    if (verbatim) append(argument, length); else quote(argument, length);
  }
  reader.end(); workspace.command[length] = 0;
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) fail(GetLastError());
  check(SetHandleInformation(job.value, HANDLE_FLAG_INHERIT, 0));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 256;
  check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
  Handle root, thread; Birth rootBirth{}, bridgeBirth = identity(GetCurrentProcess());
  bool created = false, resumed = false, signaled = false, rootObserved = false, terminated = false;
  bool attributesReady = false, failed = false;
  DWORD exitCode = 1; ULONGLONG stoppingAt = 0, cleanupDeadline = 0;
  auto stopping = [&](ULONGLONG remaining = kCleanupMs) {
    if (!stoppingAt) {
      stoppingAt = GetTickCount64(); cleanupDeadline = stoppingAt + std::min(remaining, kCleanupMs);
    }
  };
  try {
    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
    if (attributeBytes > workspace.attributes.size()) fail(ERROR_BUFFER_OVERFLOW);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(workspace.attributes.data());
    check(InitializeProcThreadAttributeList(attributes, 2, 0, &attributeBytes)); attributesReady = true;
    std::array<Handle, 3> standards;
    HANDLE inherited[3];
    const DWORD kinds[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    for (size_t index = 0; index < standards.size(); ++index) {
      HANDLE duplicate = nullptr;
      check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[index]), GetCurrentProcess(),
                            &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS));
      standards[index].set(duplicate); inherited[index] = duplicate;
    }
    HANDLE jobs[] = {job.value};
    check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), nullptr, nullptr));
    check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr));
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2]; startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process{};
    if (GetTickCount64() >= prepDeadline || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) fail(ERROR_TIMEOUT);
    check(CreateProcessW(workspace.path.data(), workspace.command.data(), nullptr, nullptr, TRUE,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
          nullptr, nullptr, &startup.StartupInfo, &process));
    root.set(process.hProcess); thread.set(process.hThread); created = true;
    rootBirth = identity(root.value);
    BOOL belongs = FALSE; check(IsProcessInJob(root.value, job.value, &belongs)); if (!belongs) fail();
    BYTE bytes[25]; Writer contained{bytes, 0, sizeof(bytes)};
    contained.byte(12); contained.birth(bridgeBirth); contained.birth(rootBirth);
    if (!control.emit(contained)) fail(ERROR_BROKEN_PIPE);
    auto acknowledgment = control.read(std::min(prepDeadline, lifetimeDeadline), owner.value);
    const BYTE operation = acknowledgment.byte();
    if (operation == 3) { const DWORD remaining = acknowledgment.u32(); acknowledgment.end(); stopping(remaining); }
    else {
      if (operation != 2) fail(); acknowledgment.end();
      if (GetTickCount64() >= std::min(prepDeadline, lifetimeDeadline) ||
          WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) fail(ERROR_TIMEOUT);
      if (ResumeThread(thread.value) != 1) fail(GetLastError());
      resumed = true;
    }
    thread.close();
  } catch (const Failure& error) {
    failed = true; control.error(error.code); stopping();
  }
  if (attributesReady) DeleteProcThreadAttributeList(reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(workspace.attributes.data()));
  // All cleanup paths share this loop and its first four-second deadline.
  for (;;) {
    try {
      const ULONGLONG tick = GetTickCount64();
      const DWORD rootWait = created && !signaled ? WaitForSingleObject(root.value, 0) : WAIT_TIMEOUT;
      if (rootWait != WAIT_TIMEOUT && rootWait != WAIT_OBJECT_0) fail(GetLastError());
      if (created && !signaled && rootWait == WAIT_OBJECT_0) {
        check(GetExitCodeProcess(root.value, &exitCode)); signaled = true;
        if (!rootObserved) {
          BYTE bytes[5]; Writer message{bytes, 0, sizeof(bytes)};
          message.byte(14); message.u32(exitCode); control.emit(message); rootObserved = true;
        }
        stopping(); // A naturally exited root does not orphan its descendants.
      }
      if (!created) { signaled = true; stopping(); }
      if (!stoppingAt && (control.broken || WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT || tick >= lifetimeDeadline)) stopping();
      if (!stoppingAt && control.available()) {
        auto operation = control.read(std::min(tick + kCleanupMs, lifetimeDeadline), owner.value);
        if (operation.byte() != 3) fail();
        const DWORD remaining = operation.u32(); operation.end(); stopping(remaining);
      }
      const DWORD count = active(job.value);
      if (stoppingAt && signaled && count == 0) {
        // Birth failure after creation is never converted into a no-child receipt.
        if (created && !rootBirth.time) fail();
        thread.close(); root.close();
        seal(receipt, request, bridgeBirth, rootBirth, exitCode);
        BYTE bytes[5]; Writer empty{bytes, 0, sizeof(bytes)};
        empty.byte(13); empty.u32(exitCode); control.emit(empty);
        job.close();
        return exitCode;
      }
      if (stoppingAt && !terminated && (!resumed || tick - stoppingAt >= kGraceMs)) {
        terminated = true; check(TerminateJobObject(job.value, 1));
      }
      if (stoppingAt && tick >= cleanupDeadline) return 1; // No receipt => unconfirmed.
    } catch (const Failure& error) {
      if (!failed) control.error(error.code);
      failed = true; stopping();
      if (!terminated) { terminated = true; TerminateJobObject(job.value, 1); }
      if (GetTickCount64() >= cleanupDeadline) return 1;
    }
    Sleep(5);
  }
}
bool absent(Birth expected) {
  if (!expected.pid && !expected.time) return true; // Only an allocated, never-created root.
  if (!expected.pid || !expected.time || expected.pid > 0x7fffffff) return false;
  Handle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, expected.pid));
  if (!process.value) return GetLastError() == ERROR_INVALID_PARAMETER;
  return !same(identity(process.value), expected) || WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0;
}
bool prove(HANDLE receipt, Reader& reader, bool cold) {
  Request request; request.base(reader); request.bound(reader);
  const BYTE contained = reader.byte(); if (contained > 1) fail();
  Birth expectedBridge{}, expectedRoot{};
  if (contained) { expectedBridge = reader.birth(); expectedRoot = reader.birth(); }
  reader.end();
  PinnedFile file; file.validate(receipt, request.path);
  if (!same(file.identity, request.file)) return false;
  LARGE_INTEGER size{}, zero{}; check(GetFileSizeEx(receipt, &size));
  if (size.QuadPart != kReceiptBytes) return false;
  check(SetFilePointerEx(receipt, zero, nullptr, FILE_BEGIN));
  DWORD received = 0; check(ReadFile(receipt, workspace.receipt.data(), kReceiptBytes, &received, nullptr));
  if (received != kReceiptBytes) return false;
  DWORD checksum = 0; memcpy(&checksum, workspace.receipt.data() + kReceiptBytes - 4, 4);
  if (checksum != crc(workspace.receipt.data(), kReceiptBytes - 4)) return false;
  Reader record{workspace.receipt.data(), kReceiptBytes};
  BYTE magic[8]; record.take(magic, 8);
  if (memcmp(magic, "PACTOWN1", 8) || record.u32() != kProtocol || record.u32() != kReceiptBytes) return false;
  std::array<BYTE, 16> ownerId{}, generation{}, receiptId{};
  record.take(ownerId.data(), 16); record.take(generation.data(), 16); record.take(receiptId.data(), 16);
  FileIdentity bound; bound.volume = record.u64(); record.take(bound.id.data(), 16);
  const Birth owner = record.birth(), bridge = record.birth(), root = record.birth();
  if (ownerId != request.ownerId || generation != request.generation || receiptId != request.receiptId ||
      !same(bound, request.file) || !same(owner, request.owner) || record.u32() != kReceiptFlags ||
      !bridge.pid || !bridge.time || (contained && (!same(bridge, expectedBridge) || !same(root, expectedRoot)))) return false;
  if (owner.pid == bridge.pid || (root.pid && (root.pid == owner.pid || root.pid == bridge.pid))) return false;
  // Recovery and current-owner receipt verification are both read-only.
  if ((cold && !absent(owner)) || !absent(bridge) || !absent(root)) return false;
  return true;
}
BYTE retire(Reader& reader) {
  Request request; request.base(reader); request.bound(reader);
  const BYTE contained = reader.byte(); if (contained > 1) fail();
  if (contained) { reader.birth(); reader.birth(); }
  reader.end();
  // The Repository has already committed a retiring intent for this exact
  // physically closed generation. This mode never proves process release.
  PinnedFile file; file.pin(request.path, true);
  if (file.missing) return 2; // already_absent, after the private directory boundary
  if (!same(file.identity, request.file)) return 0;
  LARGE_INTEGER size{}; check(GetFileSizeEx(file.leaf, &size));
  if (size.QuadPart < 0 || size.QuadPart > 2048) return 0;
  FILE_DISPOSITION_INFO disposition{TRUE};
  check(SetFileInformationByHandle(file.leaf, FileDispositionInfo, &disposition, sizeof(disposition)));
  return 1; // removed; the pinned leaf handle closes before the helper exits
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && !wcscmp(argv[1], L"identity")) {
    printf("{\"protocolVersion\":1,\"sourceSha256\":\"%s\",\"architecture\":\"%s\"}\n",
      PACT_OWNER_SOURCE_SHA256,
#if defined(_M_ARM64)
      "arm64"
#elif defined(_M_X64)
      "x64"
#else
#error Unsupported target architecture.
#endif
    );
    return 0;
  }
  if (argc != 2) return 1;
  HANDLE controlHandle = reinterpret_cast<HANDLE>(_get_osfhandle(3));
  const bool retirement = !wcscmp(argv[1], L"retire");
  HANDLE receipt = retirement ? nullptr : reinterpret_cast<HANDLE>(_get_osfhandle(4));
  if (controlHandle == INVALID_HANDLE_VALUE || (!retirement && receipt == INVALID_HANDLE_VALUE)) return 1;
  Control control{controlHandle};
  try {
    check(SetHandleInformation(controlHandle, HANDLE_FLAG_INHERIT, 0));
    if (receipt) check(SetHandleInformation(receipt, HANDLE_FLAG_INHERIT, 0));
    DWORD outbound = 0, inbound = 0;
    check(GetNamedPipeInfo(controlHandle, nullptr, &outbound, &inbound, nullptr));
    if (outbound > 65536 || inbound > 65536) fail(ERROR_BUFFER_OVERFLOW);
    const ULONGLONG deadline = GetTickCount64() + kPrepareMs;
    auto request = control.read(deadline);
    if (!wcscmp(argv[1], L"prepare")) { prepare(control, receipt, request); return 0; }
    if (!wcscmp(argv[1], L"run")) return static_cast<int>(run(control, receipt, request, deadline));
    if (retirement) {
      const BYTE result = retire(request);
      BYTE bytes[] = {17, result}; Writer reply{bytes, 2, 2};
      control.emit(reply); return result ? 0 : 1;
    }
    if (!wcscmp(argv[1], L"prove") || !wcscmp(argv[1], L"verify")) {
      const bool result = prove(receipt, request, !wcscmp(argv[1], L"prove"));
      BYTE bytes[] = {15, static_cast<BYTE>(result)}; Writer reply{bytes, 2, 2};
      control.emit(reply); return result ? 0 : 1;
    }
  } catch (const Failure& error) { control.error(error.code); }
  return 1;
}
