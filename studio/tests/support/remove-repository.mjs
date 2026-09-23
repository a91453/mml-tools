// Test support: remove a temporary directory that holds a Git repository.
//
// From Git 2.47 the auto-maintenance that `git fetch` and `git commit` start
// runs detached, so it can still be writing into the repository after the
// command returned. A test that fails straight after a fetch then cleans up
// while it runs, and rmSync ends in ENOTEMPTY (seen on CI's Git 2.55). rmSync's
// own maxRetries only retries the directory it failed on and never removes the
// files that appeared meanwhile, so the whole tree is removed again instead,
// until the background run has finished.
import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function removeRepository(dir, { attempts = 10, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' || attempt >= attempts) throw error;
      await delay(delayMs * attempt);
    }
  }
}
