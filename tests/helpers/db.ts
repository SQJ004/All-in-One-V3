import { beforeEach } from 'vitest';
import { invalidateConfig } from '../../src/core/configService.js';
import { resetStore } from '../../src/db/store.js';
import '../../src/db/models.js';

/** The store stays in memory during tests. Each test starts empty. */
export function useDatabase(): void {
  beforeEach(() => {
    invalidateConfig();
    resetStore();
  });
}
