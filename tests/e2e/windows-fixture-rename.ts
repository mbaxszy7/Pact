/** Standalone fixtures retry only the same atomic publish; callers own candidate bytes and cleanup. */
export const windowsFixtureRenameSource = String.raw`
const windowsFixtureRenameWait = new Int32Array(new SharedArrayBuffer(4))
function windowsFixtureRename(source, target, deadlineMs = 250) {
  const deadline = performance.now() + deadlineMs
  let pause = 1, failure
  for (let attempt = 0; attempt < 32; attempt++) {
    if (attempt && performance.now() >= deadline) throw failure
    try { renameSync(source, target); return }
    catch (error) {
      failure = error
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 31 || performance.now() >= deadline) throw error
      Atomics.wait(windowsFixtureRenameWait, 0, 0, Math.min(pause, Math.max(0, deadline - performance.now())))
      pause = Math.min(16, pause * 2)
    }
  }
}
`
