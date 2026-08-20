import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync
} from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { StorageSecurityError, ValidationError } from './errors.js';

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwned(stat, label) {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new StorageSecurityError(`${label} must be owned by the current user.`);
  }
}

function assertPrivateMode(stat, label) {
  if ((stat.mode & 0o077) !== 0) {
    throw new StorageSecurityError(`${label} must not be accessible by group or other users.`);
  }
}

function lstatIfPresent(pathname) {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function pathComponents(absolutePath) {
  const { root } = parse(absolutePath);
  const relative = absolutePath.slice(root.length);
  const parts = relative.length === 0 ? [] : relative.split(sep).filter(Boolean);
  const paths = [root];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    paths.push(current);
  }
  return paths;
}

function assertNoSymlinkComponents(absolutePath) {
  for (const candidate of pathComponents(absolutePath)) {
    const stat = lstatIfPresent(candidate);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new StorageSecurityError(`Storage path component ${JSON.stringify(candidate)} must not be a symbolic link.`);
    }
  }
}

export function prepareSecureDatabasePath(databasePath) {
  if (typeof databasePath !== 'string' || databasePath.length === 0 || !isAbsolute(databasePath)) {
    throw new ValidationError('databasePath must be a non-empty absolute filesystem path.');
  }
  const resolvedPath = resolve(databasePath);
  const stateDirectory = dirname(resolvedPath);
  if (stateDirectory === resolvedPath) {
    throw new StorageSecurityError('databasePath must name a file inside a private state directory.');
  }

  assertNoSymlinkComponents(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(stateDirectory);

  const directoryStat = lstatSync(stateDirectory);
  if (!directoryStat.isDirectory()) {
    throw new StorageSecurityError('The database parent must be a directory.');
  }
  assertOwned(directoryStat, 'The database state directory');
  assertPrivateMode(directoryStat, 'The database state directory');

  if (realpathSync(stateDirectory) !== stateDirectory) {
    throw new StorageSecurityError('The database state directory must resolve without indirection.');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const existingDatabase = lstatIfPresent(resolvedPath);
  if (!existingDatabase) {
    try {
      const descriptor = openSync(
        resolvedPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
        0o600
      );
      closeSync(descriptor);
      chmodSync(resolvedPath, 0o600);
    } catch (error) {
      throw new StorageSecurityError('The database file could not be created without following links.', { cause: error });
    }
  } else {
    assertSecureDatabaseFile(resolvedPath);
    try {
      const descriptor = openSync(resolvedPath, constants.O_RDWR | noFollow);
      closeSync(descriptor);
    } catch (error) {
      throw new StorageSecurityError('The database file could not be opened without following links.', { cause: error });
    }
  }

  assertSecureDatabaseFile(resolvedPath);
  return resolvedPath;
}

export function assertSecureDatabaseFile(databasePath) {
  assertNoSymlinkComponents(databasePath);
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new StorageSecurityError('The database path must be a regular file, not a link or device.');
  }
  if (stat.nlink !== 1) {
    throw new StorageSecurityError('The database file must not have additional hard links.');
  }
  assertOwned(stat, 'The database file');
  assertPrivateMode(stat, 'The database file');
  if (realpathSync(databasePath) !== databasePath) {
    throw new StorageSecurityError('The database file must resolve without indirection.');
  }
}
