/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Rev} from './fileStackState';
import type {RecordOf} from 'immutable';
import type {Author, Hash, RepoPath} from 'shared/types/common';
import type {
  ExportStack,
  ExportFile,
  ImportStack,
  ImportCommit,
  Mark,
  ImportAction,
} from 'shared/types/stack';

import {assert} from '../utils';
import {FileStackState} from './fileStackState';
import deepEqual from 'fast-deep-equal';
import {List, Map as ImMap, Set as ImSet, Record, is} from 'immutable';
import {cached} from 'shared/LRU';
import {SelfUpdate} from 'shared/immutableExt';
import {generatorContains, unwrap, zip} from 'shared/utils';

type CommitStackProps = {
  /**
   * Original stack exported by `debugexportstack`. Immutable.
   * Useful to calculate "predecessor" information.
   */
  originalStack: Readonly<ExportStack>;

  /**
   * File contents at the bottom of the stack.
   *
   * For example, when editing stack with two commits A and B:
   *
   * ```
   *    B <- draft, rev 2
   *    |
   *    A <- draft, modifies foo.txt, rev 1
   *   /
   *  P <- public, does not modify foo.txt, rev 0
   * ```
   *
   * `bottomFiles['foo.txt']` would be the `foo.txt` content in P,
   * despite P does not change `foo.txt`.
   *
   * `bottomFiles` are considered immutable - stack editing operations
   * won't change `bottomFiles` directly.
   *
   * This also assumes there are only one root of the stack.
   *
   * This implies that: every file referenced or edited by any commit
   * in the stack will be present in this map. If a file was added
   * later in the stack, it is in this map and marked as absent.
   */
  bottomFiles: Readonly<Map<RepoPath, FileState>>;

  /**
   * Mutable commit stack. Indexed by rev.
   * Only stores "modified (added, edited, deleted)" files.
   */
  stack: List<CommitState>;

  /**
   * File stack states.
   * They are constructed on demand, and provide advanced features.
   */
  fileStacks: List<FileStackState>;

  /**
   * Map from `CommitIdx` (commitRev and path) to `FileIdx` (FileStack index and rev).
   * Note the commitRev could be -1, meaning that `bottomFiles` is used.
   */
  commitToFile: ImMap<CommitIdx, FileIdx>;

  /**
   * Reverse (swapped key and value) mapping of `commitToFile` mapping.
   * Note the commitRev could be -1, meaning that `bottomFiles` is used.
   */
  fileToCommit: ImMap<FileIdx, CommitIdx>;
};

// Factory function for creating instances.
// Its type is the factory function (or the "class type" in OOP sense).
const CommitStackRecord = Record<CommitStackProps>({
  originalStack: [],
  bottomFiles: new Map(),
  stack: List(),
  fileStacks: List(),
  commitToFile: ImMap(),
  fileToCommit: ImMap(),
});

// Type of *instances* created by the `CommitStackRecord`.
// This makes `CommitStackState` work more like a common OOP `class Foo`:
// `new Foo(...)` is a constructor, and `Foo` is the type of the instances,
// not the constructor or factory.
type CommitStackRecord = RecordOf<CommitStackProps>;

/**
 * A stack of commits with stack editing features.
 *
 * Provides read write APIs for editing the stack.
 * Under the hood, continuous changes to a same file are grouped
 * to file stacks. Part of analysis and edit operations are deletegated
 * to corrosponding file stacks.
 */
export class CommitStackState extends SelfUpdate<CommitStackRecord> {
  // Initial setup.

  /**
   * Construct from an exported stack. For efficient operatoins,
   * call `.buildFileStacks()` to build up states.
   *
   * `record` initialization is for internal use only.
   */
  constructor(originalStack?: Readonly<ExportStack>, record?: CommitStackRecord) {
    if (originalStack !== undefined) {
      const bottomFiles = getBottomFilesFromExportStack(originalStack);
      const stack = getCommitStatesFromExportStack(originalStack);
      super(
        CommitStackRecord({
          originalStack,
          bottomFiles,
          stack,
        }),
      );
    } else if (record !== undefined) {
      super(record);
    } else {
      super(CommitStackRecord());
    }
  }

  // Delegates to SelfUpdate.inner

  get originalStack(): Readonly<ExportStack> {
    return this.inner.originalStack;
  }

  get bottomFiles(): Readonly<Map<RepoPath, FileState>> {
    return this.inner.bottomFiles;
  }

  get stack(): List<CommitState> {
    return this.inner.stack;
  }

  get fileStacks(): List<FileStackState> {
    return this.inner.fileStacks;
  }

  get commitToFile(): ImMap<CommitIdx, FileIdx> {
    return this.inner.commitToFile;
  }

  get fileToCommit(): ImMap<FileIdx, CommitIdx> {
    return this.inner.fileToCommit;
  }

  merge(props: Partial<CommitStackProps>): CommitStackState {
    return new CommitStackState(undefined, this.inner.merge(props));
  }

  set<K extends keyof CommitStackProps>(key: K, value: CommitStackProps[K]): CommitStackState {
    return new CommitStackState(undefined, this.inner.set(key, value));
  }

  // Read operations.

  /** Returns all valid revs. */
  revs(): Rev[] {
    return [...this.stack.keys()];
  }

  /**
   * Return mutable revs.
   * This filters out public or commits outisde the original stack export request.
   */
  mutableRevs(): Rev[] {
    return [...this.stack.filter(c => c.immutableKind !== 'hash').map(c => c.rev)];
  }

  /**
   * Get the file at the given `rev`.
   *
   * Returns `ABSENT_FILE` if the file does not exist in the commit.
   * Throws if the stack does not have information about the path.
   *
   * Note this is different from `this.stack[rev].files.get(path)`,
   * since `files` only tracks modified files, not existing files
   * created from the bottom of the stack.
   */
  getFile(rev: Rev, path: RepoPath): FileState {
    for (const logRev of this.log(rev)) {
      const commit = this.stack.get(logRev);
      if (commit == null) {
        return ABSENT_FILE;
      }
      const file = commit.files.get(path);
      if (file !== undefined) {
        // Commit modifieds `file`.
        return file;
      }
    }
    const file = this.bottomFiles.get(path) ?? ABSENT_FILE;
    if (file === undefined) {
      throw new Error(
        `file ${path} is not tracked by stack (tracked files: ${JSON.stringify(
          this.getAllPaths(),
        )})`,
      );
    }
    return file;
  }

  /** Get all file paths ever referred (via "copy from") or changed in the stack. */
  getAllPaths(): RepoPath[] {
    return [...this.bottomFiles.keys()].sort();
  }

  /** List revs, starting from the given rev. */
  *log(startRev: Rev): Generator<Rev, void> {
    const toVisit = [startRev];
    while (true) {
      const rev = toVisit.pop();
      if (rev === undefined) {
        break;
      }
      yield rev;
      const commit = this.stack.get(rev);
      if (commit != null) {
        // Visit parent commits.
        commit.parents.forEach(parentRev => {
          assert(parentRev < rev, 'parent rev must < child to prevent infinite loop in log()');
          toVisit.push(parentRev);
        });
      }
    }
  }

  /**
   * List revs that change the given file, starting from the given rev.
   * Optionally follow renames.
   */
  *logFile(
    startRev: Rev,
    startPath: RepoPath,
    followRenames = false,
  ): Generator<[Rev, RepoPath], void> {
    let path = startPath;
    for (const rev of this.log(startRev)) {
      const commit = this.stack.get(rev);
      if (commit == null) {
        continue;
      }
      const file = commit.files.get(path);
      if (file !== undefined) {
        yield [rev, path];
      }
      if (followRenames && file?.copyFrom) {
        path = file.copyFrom;
      }
    }
  }

  // "Save changes" related.

  /**
   * Produce a `ImportStack` useful for the `debugimportstack` command
   * to save changes.
   *
   * Note this function only returns parts that are changed. If nothing is
   * changed, this function might return an empty array.
   *
   * Options:
   * - goto: specify a rev or (old commit) to goto. The rev must be changed
   *   otherwise this parameter is ignored.
   * - preserveDirtyFiles: if true, do not change files in the working copy.
   *   Under the hood, this changes the "goto" to "reset".
   *
   * Example use-cases:
   * - Editing a stack (clean working copy): goto = origCurrentHash
   * - commit -i: create new rev, goto = maxRev, preserveDirtyFiles = true
   * - amend -i, absorb: goto = origCurrentHash, preserveDirtyFiles = true
   */
  calculateImportStack(opts?: {goto?: Rev | Hash; preserveDirtyFiles?: boolean}): ImportStack {
    // Resolve goto to a Rev.
    // Special case: if it's at the old stack top, use the new stack top instead.
    const gotoRev: Rev | undefined =
      typeof opts?.goto === 'string'
        ? this.originalStack.at(-1)?.node == opts.goto
          ? this.stack.last()?.rev
          : this.stack.findLastKey(c => c.originalNodes.has(opts.goto as string))
        : opts?.goto;

    // Figure out the first changed rev.
    const state = this.useFileContent();
    const originalState = new CommitStackState(state.originalStack);
    const firstChangedRev = state.stack.findIndex((commit, i) => {
      const originalCommit = originalState.stack.get(i);
      return originalCommit == null || !is(commit, originalCommit);
    });

    // Figure out what commits are changed.
    const changedCommits: CommitState[] =
      firstChangedRev < 0 ? [] : state.stack.slice(firstChangedRev).toArray();
    const changedRevs: Set<Rev> = new Set(changedCommits.map(c => c.rev));
    const revToMark = (rev: Rev): Mark => `:r${rev}`;
    const revToMarkOrHash = (rev: Rev): Mark | Hash => {
      if (changedRevs.has(rev)) {
        return revToMark(rev);
      } else {
        const nodes = unwrap(state.stack.get(rev)).originalNodes;
        assert(nodes.size === 1, 'unchanged commits should have exactly 1 nodes');
        return unwrap(nodes.first());
      }
    };

    // "commit" new commits based on state.stack.
    const actions: ImportAction[] = changedCommits.map(commit => {
      assert(commit.immutableKind !== 'hash', 'immutable commits should not be changed');
      const newFiles: {[path: RepoPath]: ExportFile | null} = Object.fromEntries(
        [...commit.files.entries()].map(([path, file]) => {
          if (isAbsent(file)) {
            return [path, null];
          }
          const newFile: ExportFile = {};
          if (typeof file.data === 'string') {
            newFile.data = file.data;
          } else if (file.data instanceof Base85) {
            newFile.dataBase85 = file.data.dataBase85;
          }
          if (file.copyFrom != null) {
            newFile.copyFrom = file.copyFrom;
          }
          if (file.flags != null) {
            newFile.flags = file.flags;
          }
          return [path, newFile];
        }),
      );
      const importCommit: ImportCommit = {
        mark: revToMark(commit.rev),
        author: commit.author,
        date: [commit.date.unix, commit.date.tz],
        text: commit.text,
        parents: commit.parents.toArray().map(revToMarkOrHash),
        predecessors: commit.originalNodes.toArray(),
        files: newFiles,
      };
      return ['commit', importCommit];
    });

    // "goto" or "reset" as requested.
    if (gotoRev != null && changedRevs.has(gotoRev)) {
      if (opts?.preserveDirtyFiles) {
        actions.push(['reset', {mark: revToMark(gotoRev)}]);
      } else {
        actions.push(['goto', {mark: revToMark(gotoRev)}]);
      }
    }

    // "hide" commits that disappear from state.originalStack => state.stack.
    // Only requested mutable commits are considered.
    const coveredNodes: Set<Hash> = state.stack.reduce((acc, commit) => {
      commit.originalNodes.forEach((n: Hash): Set<Hash> => acc.add(n));
      return acc;
    }, new Set<Hash>());
    const orphanedNodes: Hash[] = state.originalStack
      .filter(c => c.requested && !c.immutable && !coveredNodes.has(c.node))
      .map(c => c.node);
    if (orphanedNodes.length > 0) {
      actions.push(['hide', {nodes: orphanedNodes}]);
    }

    return actions;
  }

  // File stack related.

  /**
   * Get the parent version of a file and its introducing rev.
   * If the returned `rev` is -1, it means the file comes from
   * "bottomFiles", aka. its introducing rev is outside the stack.
   */
  parentFile(rev: Rev, path: RepoPath, followRenames = true): [Rev, RepoPath, FileState] {
    let prevRev = -1;
    let prevPath = path;
    let prevFile = unwrap(this.bottomFiles.get(path));
    const logFile = this.logFile(rev, path, followRenames);
    for (const [logRev, logPath] of logFile) {
      if (logRev !== rev) {
        [prevRev, prevPath] = [logRev, logPath];
        prevFile = unwrap(this.stack.get(prevRev)?.files?.get(prevPath));
        break;
      }
    }
    return [prevRev, prevPath, prevFile];
  }

  /** Assert that the revs are in the right order. */
  assertRevOrder() {
    assert(
      this.stack.every(c => c.parents.every(p => p < c.rev)),
      'parent rev should < child rev',
    );
    assert(
      this.stack.every((c, i) => c.rev === i),
      'rev should equal to stack index',
    );
  }

  /**
   * (Re-)build file stacks and mappings.
   */
  buildFileStacks(): CommitStackState {
    const fileStacks: FileStackState[] = [];
    let commitToFile = ImMap<CommitIdx, FileIdx>();
    let fileToCommit = ImMap<FileIdx, CommitIdx>();

    this.assertRevOrder();

    const processFile = (state: CommitStackState, rev: Rev, file: FileState, path: RepoPath) => {
      const [prevRev, prevPath, prevFile] = state.parentFile(rev, path);
      if (isUtf8(file)) {
        // File was added or modified and has utf-8 content.
        let fileAppended = false;
        if (prevRev >= 0) {
          // Try to reuse an existing file stack.
          const prev = commitToFile.get(CommitIdx({rev: prevRev, path: prevPath}));
          if (prev) {
            const prevFileStack = fileStacks[prev.fileIdx];
            // File stack history is linear. Only reuse it if its last
            // rev matches `prevFileRev`
            if (prevFileStack.source.revLength === prev.fileRev + 1) {
              const fileRev = prev.fileRev + 1;
              fileStacks[prev.fileIdx] = prevFileStack.editText(
                fileRev,
                state.getUtf8Data(file),
                false,
              );
              const cIdx = CommitIdx({rev, path});
              const fIdx = FileIdx({fileIdx: prev.fileIdx, fileRev});
              commitToFile = commitToFile.set(cIdx, fIdx);
              fileToCommit = fileToCommit.set(fIdx, cIdx);
              fileAppended = true;
            }
          }
        }
        if (!fileAppended) {
          // Cannot reuse an existing file stack. Create a new file stack.
          const fileIdx = fileStacks.length;
          let fileTextList = [state.getUtf8Data(file)];
          let fileRev = 0;
          if (isUtf8(prevFile)) {
            // Use "prevFile" as rev 0 (immutable public).
            fileTextList = [state.getUtf8Data(prevFile), ...fileTextList];
            const cIdx = CommitIdx({rev: prevRev, path: prevPath});
            const fIdx = FileIdx({fileIdx, fileRev});
            commitToFile = commitToFile.set(cIdx, fIdx);
            fileToCommit = fileToCommit.set(fIdx, cIdx);
            fileRev = 1;
          }
          const fileStack = new FileStackState(fileTextList);
          fileStacks.push(fileStack);
          const cIdx = CommitIdx({rev, path});
          const fIdx = FileIdx({fileIdx, fileRev});
          commitToFile = commitToFile.set(cIdx, fIdx);
          fileToCommit = fileToCommit.set(fIdx, cIdx);
        }
      }
    };

    // Migrate off 'fileStack' type, since we are going to replace the file stacks.
    const state = this.useFileContent();

    state.stack.forEach((commit, rev) => {
      const files = commit.files;
      // Process order: renames, non-copy, copies.
      const priorityFiles: [number, RepoPath, FileState][] = [...files.entries()].map(
        ([path, file]) => {
          const priority = isRename(commit, path) ? 0 : file.copyFrom == null ? 1 : 2;
          return [priority, path, file];
        },
      );
      const renamed = new Set<RepoPath>();
      priorityFiles
        .sort(([aPri, aPath, _aFile], [bPri, bPath, _bFile]) =>
          aPri < bPri || (aPri === bPri && aPath < bPath) ? -1 : 1,
        )
        .forEach(([priority, path, file]) => {
          // Skip already "renamed" absent files.
          let skip = false;
          if (priority === 0 && file.copyFrom != null) {
            renamed.add(file.copyFrom);
          } else {
            skip = isAbsent(file) && renamed.has(path);
          }
          if (!skip) {
            processFile(state, rev, file, path);
          }
        });
    });

    return state.merge({
      fileStacks: List(fileStacks),
      commitToFile,
      fileToCommit,
    });
  }

  /** Build file stacks if it's not present. */
  maybeBuildFileStacks(): CommitStackState {
    return this.fileStacks.size === 0 ? this.buildFileStacks() : this;
  }

  /**
   * Switch file contents to use FileStack as source of truth.
   * Useful when using FileStack to edit files.
   */
  useFileStack(): CommitStackState {
    const state = this.maybeBuildFileStacks();
    return state.updateEachFile((rev, file, path) => {
      if (typeof file.data === 'string') {
        const index = state.commitToFile.get(CommitIdx({rev, path}));
        if (index != null) {
          return file.set('data', index);
        }
      }
      return file;
    });
  }

  /**
   * Switch file contents to use string as source of truth.
   * Useful when rebuilding FileStack.
   */
  useFileContent(): CommitStackState {
    return this.updateEachFile((_rev, file) => {
      if (typeof file.data !== 'string' && isUtf8(file)) {
        const data = this.getUtf8Data(file);
        return file.set('data', data);
      }
      return file;
    });
  }

  /**
   * Iterate through all changed files via the given function.
   */
  updateEachFile(
    func: (commitRev: Rev, file: FileState, path: RepoPath) => FileState,
  ): CommitStackState {
    const newStack = this.stack.map(commit => {
      const newFiles = commit.files.map((file, path) => {
        return func(commit.rev, file, path);
      });
      return commit.set('files', newFiles);
    });
    return this.set('stack', newStack);
  }

  /**
   * Describe all file stacks for testing purpose.
   * Each returned string represents a file stack.
   *
   * Output in `rev:commit/path(content)` format.
   * If `(content)` is left out it means the file at the rev is absent.
   * If `commit` is `.` then it comes from `bottomFiles` meaning that
   * the commit last modifies the path might be outside the stack.
   *
   * Rev 0 is usually the "public" version that is not editable.
   *
   * For example, `0:./x.txt 1:A/x.txt(33) 2:B/y.txt(33)` means:
   * commit A added `x.txt` with the content `33`, and commit B renamed it to
   * `y.txt`.
   *
   * `0:./z.txt(11) 1:A/z.txt(22) 2:C/z.txt` means: `z.txt` existed at
   * the bottom of the stack with the content `11`. Commit A modified
   * its content to `22` and commit C deleted `z.txt`.
   */
  describeFileStacks(showContent = true): string[] {
    const state = this.maybeBuildFileStacks();
    const fileToCommit = state.fileToCommit;
    const stack = state.stack;
    return state.fileStacks
      .map((fileStack, fileIdx) => {
        return fileStack
          .revs()
          .map(fileRev => {
            const value = fileToCommit.get(FileIdx({fileIdx, fileRev}));
            const spans = [`${fileRev}:`];
            assert(value != null, 'fileToCommit should have all file stack revs');
            const {rev, path} = value;
            const [commitTitle, absent] =
              rev < 0
                ? ['.', isAbsent(state.bottomFiles.get(path))]
                : ((c: CommitState): [string, boolean] => [
                    c.text.split('\n').at(0) || [...c.originalNodes].at(0) || '?',
                    isAbsent(c.files.get(path)),
                  ])(unwrap(stack.get(rev)));
            spans.push(`${commitTitle}/${path}`);
            if (showContent && !absent) {
              spans.push(`(${fileStack.getRev(fileRev)})`);
            }
            return spans.join('');
          })
          .join(' ');
      })
      .toArray();
  }

  /** Extract utf-8 data from a file. */
  getUtf8Data(file: FileState): string {
    if (typeof file.data === 'string') {
      return file.data;
    }
    if (file.data instanceof FileIdx) {
      return unwrap(this.fileStacks.get(file.data.fileIdx)).getRev(file.data.fileRev);
    } else {
      throw new Error('getUtf8Data called on non-utf8 file.');
    }
  }

  /** Test if two files have the same data. */
  isEqualFile(a: FileState, b: FileState): boolean {
    if ((a.flags ?? '') !== (b.flags ?? '')) {
      return false;
    }
    if (isUtf8(a) && isUtf8(b)) {
      return this.getUtf8Data(a) === this.getUtf8Data(b);
    }
    // We assume base85 data is immutable, non-utf8 so they won't match utf8 data.
    if (a.data instanceof Base85 && b.data instanceof Base85) {
      return a.data.dataBase85 === b.data.dataBase85;
    }
    return false;
  }

  /** Test if the stack is linear. */
  isStackLinear(): boolean {
    return this.stack.every(
      (commit, rev) =>
        rev === 0 || (commit.parents.size === 1 && commit.parents.first() === rev - 1),
    );
  }

  // Histedit-related opeations.

  /**
   * Calculate the dependencies of revisions.
   * For example, `{5: [3, 1]}` means rev 5 depends on rev 3 and rev 1.
   *
   * This is used to detect what's reasonable when reordering and dropping
   * commits. For example, if rev 3 depends on rev 2, then rev 3 cannot be
   * moved to be an ancestor of rev 2, and rev 2 cannot be dropped alone.
   */
  @cached({cacheSize: 100})
  calculateDepMap(): Readonly<Map<Rev, Set<Rev>>> {
    const state = this.maybeBuildFileStacks();
    const depMap = new Map<Rev, Set<Rev>>(state.stack.map(c => [c.rev, new Set()]));

    const fileIdxRevToCommitRev = (fileIdx: FileStackIndex, fileRev: Rev): Rev =>
      unwrap(state.fileToCommit.get(FileIdx({fileIdx, fileRev}))).rev;

    // Ask FileStack for dependencies about content edits.
    state.fileStacks.forEach((fileStack, fileIdx) => {
      const fileDepMap = fileStack.calculateDepMap();
      const toCommitRev = (rev: Rev) => fileIdxRevToCommitRev(fileIdx, rev);
      // Convert file revs to commit revs.
      fileDepMap.forEach((valueFileRevs, keyFileRev) => {
        const keyCommitRev = toCommitRev(keyFileRev);
        if (keyCommitRev >= 0) {
          const set = unwrap(depMap.get(keyCommitRev));
          valueFileRevs.forEach(fileRev => {
            const rev = toCommitRev(fileRev);
            if (rev >= 0) {
              set.add(rev);
            }
          });
        }
      });
    });

    // Besides, file deletion / addition / renames also introduce dependencies.
    state.stack.forEach(commit => {
      const set = unwrap(depMap.get(commit.rev));
      commit.files.forEach((file, path) => {
        const [prevRev, prevPath, prevFile] = state.parentFile(commit.rev, path, true);
        if (prevRev >= 0 && (isAbsent(prevFile) !== isAbsent(file) || prevPath !== path)) {
          set.add(prevRev);
        }
      });
    });

    return depMap;
  }

  /** Return the single parent rev, or null. */
  singleParentRev(rev: Rev): Rev | null {
    const commit = this.stack.get(rev);
    const parents = commit?.parents;
    if (parents != null) {
      const parentRev = parents?.first();
      if (parentRev != null && parents.size === 1) {
        return parentRev;
      }
    }
    return null;
  }

  /**
   * Test if the commit can be folded with its parent.
   */
  @cached({cacheSize: 1000})
  canFoldDown(rev: Rev): boolean {
    if (rev <= 0) {
      return false;
    }
    const commit = this.stack.get(rev);
    if (commit == null) {
      return false;
    }
    const parentRev = this.singleParentRev(rev);
    if (parentRev == null) {
      return false;
    }
    const parent = unwrap(this.stack.get(parentRev));
    if (commit.immutableKind !== 'none' || parent.immutableKind !== 'none') {
      return false;
    }
    // This is a bit conservative. But we're not doing complex content check for now.
    const childCount = this.stack.count(c => c.parents.includes(parentRev));
    if (childCount > 1) {
      return false;
    }
    return true;
  }

  /**
   * Drop the given `rev`.
   * The callsite should take care of `files` updates.
   */
  rewriteStackDroppingRev(rev: Rev): CommitStackState {
    const revMapFunc = (r: Rev) => (r < rev ? r : r - 1);
    const newStack = this.stack
      .filter(c => c.rev !== rev)
      .map(c => rewriteCommitRevs(c, revMapFunc));
    // Recalculate file stacks.
    return this.set('stack', newStack).buildFileStacks();
  }

  /**
   * Fold the commit with its parent.
   * This should only be called when `canFoldDown(rev)` returned `true`.
   */
  foldDown(rev: Rev) {
    const commit = unwrap(this.stack.get(rev));
    const parentRev = unwrap(this.singleParentRev(rev));
    const parent = unwrap(this.stack.get(parentRev));
    let newParentFiles = parent.files;
    const newFiles = commit.files.map((origFile, path) => {
      // Fold copyFrom. `-` means "no change".
      //
      // | grand  | direct |      |                   |
      // | parent | parent | rev  | folded (copyFrom) |
      // +--------------------------------------------+
      // | A      | A->B   | B->C | A->C   (parent)   |
      // | A      | A->B   | B    | A->B   (parent)   |
      // | A      | A->B   | -    | A->B   (parent)   |
      // | A      | A      | A->C | A->C   (rev)      |
      // | A      | -      | A->C | A->C   (rev)      |
      // | -      | B      | B->C | C      (drop)     |
      let file = origFile;
      const optionalParentFile = newParentFiles.get(file.copyFrom ?? path);
      const copyFrom = optionalParentFile?.copyFrom ?? file.copyFrom;
      if (copyFrom != null && isAbsent(this.parentFile(parentRev, file.copyFrom ?? path)[2])) {
        // "copyFrom" is no longer valid (not existed in grand parent). Drop it.
        file = file.set('copyFrom', undefined);
      } else {
        file = file.set('copyFrom', copyFrom);
      }
      if (this.isEqualFile(this.parentFile(parentRev, path, false /* [1] */)[2], file)) {
        // The file changes cancel out. Remove it.
        // [1]: we need to disable following renames when comparing files for cancel-out check.
        newParentFiles = newParentFiles.delete(path);
      } else {
        // Fold the change of this file.
        newParentFiles = newParentFiles.set(path, file);
      }
      return file;
    });

    // Fold other properties to parent.
    const newParentText = isMeaningfulText(commit.text)
      ? `${parent.text.trim()}\n\n${commit.text}`
      : parent.text;
    const newParent = parent.merge({
      text: newParentText,
      date: commit.date,
      originalNodes: parent.originalNodes.merge(commit.originalNodes),
      files: newParentFiles,
    });
    const newCommit = commit.set('files', newFiles);
    const newStack = this.stack.withMutations(mutStack => {
      mutStack.set(parentRev, newParent).set(rev, newCommit);
    });

    return this.set('stack', newStack).rewriteStackDroppingRev(rev);
  }

  /**
   * Test if the commit can be dropped. That is, none of its descendants depend on it.
   */
  @cached({cacheSize: 1000})
  canDrop(rev: Rev): boolean {
    if (rev < 0 || this.stack.get(rev)?.immutableKind !== 'none') {
      return false;
    }
    const depMap = this.calculateDepMap();
    for (const [currentRev, dependentRevs] of depMap.entries()) {
      if (dependentRevs.has(rev) && generatorContains(this.log(currentRev), rev)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Drop a commit. Changes made by the commit will be removed in its
   * descendants.
   *
   * This should only be called when `canDrop(rev)` returned `true`.
   */
  drop(rev: Rev): CommitStackState {
    let state = this.useFileStack().inner;
    const commit = unwrap(state.stack.get(rev));
    commit.files.forEach((file, path) => {
      const fileIdxRev: FileIdx | undefined = state.commitToFile.get(CommitIdx({rev, path}));
      if (fileIdxRev != null) {
        const {fileIdx, fileRev} = fileIdxRev;
        const fileStack = unwrap(state.fileStacks.get(fileIdx));
        // Drop the rev by remapping it to an unused rev.
        const unusedFileRev = fileStack.source.revLength;
        const newFileStack = fileStack.remapRevs(new Map([[fileRev, unusedFileRev]]));
        state = state.setIn(['fileStacks', fileIdx], newFileStack);
      }
    });

    return new CommitStackState(undefined, state).rewriteStackDroppingRev(rev);
  }

  /**
   * Check if reorder is conflict-free.
   *
   * `order` defines the new order as a "from rev" list.
   * For example, when `this.revs()` is `[0, 1, 2, 3]` and `order` is
   * `[0, 2, 3, 1]`, it means moving the second (rev 1) commit to the
   * stack top.
   *
   * Reordering in a non-linear stack is not supported and will return
   * `false`. This is because it's tricky to describe the desired
   * new parent relationships with just `order`.
   *
   * If `order` is `this.revs()` then no reorder is done.
   */
  canReorder(order: Rev[]): boolean {
    const state = this.maybeBuildFileStacks();
    if (!state.isStackLinear()) {
      return false;
    }
    if (
      !deepEqual(
        [...order].sort((a, b) => a - b),
        state.revs(),
      )
    ) {
      return false;
    }

    // "hash" immutable commits cannot be moved.
    if (state.stack.some((commit, rev) => commit.immutableKind === 'hash' && order[rev] !== rev)) {
      return false;
    }

    const map = new Map<Rev, Rev>(order.map((fromRev, toRev) => [fromRev, toRev]));
    // Check dependencies.
    const depMap = state.calculateDepMap();
    for (const [rev, depRevs] of depMap) {
      const newRev = map.get(rev);
      if (newRev == null) {
        return false;
      }
      for (const depRev of depRevs) {
        const newDepRev = map.get(depRev);
        if (newDepRev == null) {
          return false;
        }
        if (!generatorContains(state.log(newRev), newDepRev)) {
          return false;
        }
      }
    }
    // Passed checks.
    return true;
  }

  canMoveDown(rev: Rev): boolean {
    return rev > 0 && this.canMoveUp(rev - 1);
  }

  @cached({cacheSize: 1000})
  canMoveUp(rev: Rev): boolean {
    return this.canReorder(reorderedRevs(this, rev));
  }

  /**
   * Reorder stack. Similar to running `histedit`, follwed by reordering
   * commits.
   *
   * See `canReorder` for the meaning of `order`.
   * This should only be called when `canReorder(order)` returned `true`.
   */
  reorder(order: Rev[]): CommitStackState {
    const commitRevMap = new Map<Rev, Rev>(order.map((fromRev, toRev) => [fromRev, toRev]));

    // Reorder file contents. This is somewhat tricky involving multiple
    // mappings. Here is an example:
    //
    //   Stack: A-B-C-D. Original file contents: [11, 112, 0112, 01312].
    //   Reorder to: A-D-B-C. Expected result: [11, 131, 1312, 01312].
    //
    // First, we figure out the file stack, and reorder it. The file stack
    // now has the content [11 (A), 131 (B), 1312 (C), 01312 (D)], but the
    // commit stack is still in the A-B-C-D order and refers to the file stack
    // using **fileRev**s. If we blindly reorder the commit stack to A-D-B-C,
    // the resulting files would be [11 (A), 01312 (D), 131 (B), 1312 (C)].
    //
    // To make it work properly, we apply a reverse mapping (A-D-B-C =>
    // A-B-C-D) to the file stack before reordering commits, changing
    // [11 (A), 131 (D), 1312 (B), 01312 (C)] to [11 (A), 1312 (B), 01312 (C),
    // 131 (D)]. So after the commit remapping it produces the desired
    // output.
    let state = this.useFileStack();
    const newFileStacks = state.fileStacks.map((origFileStack, fileIdx) => {
      let fileStack: FileStackState = origFileStack;

      // file revs => commit revs => mapped commit revs => mapped file revs
      const fileRevs = fileStack.revs();
      const commitRevPaths: CommitIdx[] = fileRevs.map(fileRev =>
        unwrap(state.fileToCommit.get(FileIdx({fileIdx, fileRev}))),
      );
      const commitRevs: Rev[] = commitRevPaths.map(({rev}) => rev);
      const mappedCommitRevs: Rev[] = commitRevs.map(rev => commitRevMap.get(rev) ?? rev);
      // commitRevs and mappedCommitRevs might not overlap, although they
      // have the same length (fileRevs.length). Turn them into compact
      // sequence to reason about.
      const fromRevs: Rev[] = compactSequence(commitRevs);
      const toRevs: Rev[] = compactSequence(mappedCommitRevs);
      if (deepEqual(fromRevs, toRevs)) {
        return fileStack;
      }
      // Mapping: zip(original revs, mapped file revs)
      const fileRevMap = new Map<Rev, Rev>(zip(fromRevs, toRevs));
      fileStack = fileStack.remapRevs(fileRevMap);
      // Apply the reverse mapping. See the above comment for why this is necessary.
      return new FileStackState(fileRevs.map(fileRev => fileStack.getRev(toRevs[fileRev])));
    });
    state = state.set('fileStacks', newFileStacks);

    // Update state.stack.
    const newStack = state.stack.map((_commit, rev) => {
      const commit = unwrap(state.stack.get(order[rev]));
      return commit.merge({parents: List(rev > 0 ? [rev - 1] : []), rev});
    });
    state = state.set('stack', newStack);

    return state.buildFileStacks();
  }
}

function getBottomFilesFromExportStack(stack: Readonly<ExportStack>): Map<RepoPath, FileState> {
  // bottomFiles requires that the stack only has one root.
  checkStackSingleRoot(stack);

  // Calculate bottomFiles.
  const bottomFiles: Map<RepoPath, FileState> = new Map();
  stack.forEach(commit => {
    for (const [path, file] of Object.entries(commit.relevantFiles ?? {})) {
      if (!bottomFiles.has(path)) {
        bottomFiles.set(path, convertExportFileToFileState(file));
      }
    }

    // Files not yet existed in `bottomFiles` means they are added (in root commits)
    // mark them as "missing" in the stack bottom.
    for (const path of Object.keys(commit.files ?? {})) {
      if (!bottomFiles.has(path)) {
        bottomFiles.set(path, ABSENT_FILE);
      }
    }
  });

  return bottomFiles;
}

function convertExportFileToFileState(file: ExportFile | null): FileState {
  if (file == null) {
    return ABSENT_FILE;
  }
  return FileState({
    data: file.data != null ? file.data : Base85({dataBase85: unwrap(file.dataBase85)}),
    copyFrom: file.copyFrom,
    flags: file.flags,
  });
}

function getCommitStatesFromExportStack(stack: Readonly<ExportStack>): List<CommitState> {
  checkStackParents(stack);

  // Prepare nodeToRev convertion.
  const revs: Rev[] = [...stack.keys()];
  const nodeToRevMap: Map<Hash, Rev> = new Map(revs.map(rev => [stack[rev].node, rev]));
  const nodeToRev = (node: Hash): Rev => {
    const rev = nodeToRevMap.get(node);
    if (rev == null) {
      throw new Error(
        `Rev ${rev} should be known ${JSON.stringify(nodeToRevMap)} (bug in debugexportstack?)`,
      );
    }
    return rev;
  };

  // Calculate requested stack.
  const commitStates = stack.map(commit =>
    CommitState({
      originalNodes: ImSet([commit.node]),
      rev: nodeToRev(commit.node),
      key: commit.node,
      author: commit.author,
      date: DateTuple({unix: commit.date[0], tz: commit.date[1]}),
      text: commit.text,
      // Treat commits that are not requested explicitly as immutable too.
      immutableKind: commit.immutable || !commit.requested ? 'hash' : 'none',
      parents: List((commit.parents ?? []).map(p => nodeToRev(p))),
      files: ImMap<RepoPath, FileState>(
        Object.entries(commit.files ?? {}).map(([path, file]) => [
          path,
          convertExportFileToFileState(file),
        ]),
      ),
    }),
  );

  return List(commitStates);
}

/** Check that there is only one root in the stack. */
function checkStackSingleRoot(stack: Readonly<ExportStack>) {
  const rootNodes = stack.filter(commit => (commit.parents ?? []).length === 0);
  if (rootNodes.length > 1) {
    throw new Error(
      `Multiple roots ${JSON.stringify(rootNodes.map(c => c.node))} is not supported`,
    );
  }
}

/**
 * Check the exported stack and throws if it breaks assumptions.
 * - No duplicated commits.
 * - "parents" refer to other commits in the stack.
 */
function checkStackParents(stack: Readonly<ExportStack>) {
  const knownNodes = new Set();
  stack.forEach(commit => {
    const parents = commit.parents ?? [];
    if (parents.length > 0) {
      if (!commit.requested) {
        throw new Error(
          `Requested commit ${commit.node} should not have parents ${JSON.stringify(
            parents,
          )} (bug in debugexportstack?)`,
        );
      }
      parents.forEach(parentNode => {
        if (!knownNodes.has(parentNode)) {
          throw new Error(`Parent commit ${parentNode} is not exported (bug in debugexportstack?)`);
        }
      });
    }
    if (parents.length > 1) {
      throw new Error(`Merge commit ${commit.node} is not supported`);
    }
    knownNodes.add(commit.node);
  });
  if (knownNodes.size != stack.length) {
    throw new Error('Commit stack has duplicated nodes (bug in debugexportstack?)');
  }
}

/** Rewrite fields that contains `rev` based on the mapping function. */
function rewriteCommitRevs(commit: CommitState, revMapFunc: (rev: Rev) => Rev): CommitState {
  return commit.merge({
    rev: revMapFunc(commit.rev),
    parents: commit.parents.map(revMapFunc),
  });
}

/** Guess if commit message is meaningful. Messages like "wip" or "fixup" are meaningless. */
function isMeaningfulText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes(' ') || trimmed.includes('\n') || trimmed.length > 20;
}

/** Check if a path at the given commit is a rename. */
function isRename(commit: CommitState, path: RepoPath): boolean {
  const files = commit.files;
  const copyFromPath = files.get(path)?.copyFrom;
  if (copyFromPath == null) {
    return false;
  }
  return isAbsent(files.get(copyFromPath));
}

/** Test if a file is absent. */
function isAbsent(file: FileState | undefined): boolean {
  if (file == null) {
    return true;
  }
  return file.flags === ABSENT_FLAG;
}

/** Test if a file has utf-8 content. */
function isUtf8(file: FileState): boolean {
  return typeof file.data === 'string' || file.data instanceof FileIdx;
}

/**
 * Turn distinct numbers to a 0..n sequence preserving the order.
 * For example, turn [0, 100, 50] into [0, 2, 1].
 */
function compactSequence(revs: Rev[]): Rev[] {
  const sortedRevs = [...revs].sort((aRev, bRev) => aRev - bRev);
  return revs.map(rev => sortedRevs.indexOf(rev));
}

/** Reorder rev and rev + 1. Return [] if rev is out of ragne */
export function reorderedRevs(state: CommitStackState, rev: number): Rev[] {
  // Basically, `toSpliced`, but it's not avaialble everywhere.
  const order = state.revs();
  if (rev < 0 || rev >= order.length - 1) {
    return [];
  }
  const rev1 = order[rev];
  const rev2 = order[rev + 1];
  order.splice(rev, 2, rev2, rev1);
  return order;
}

type DateTupleProps = {
  /** UTC Unix timestamp in seconds. */
  unix: number;
  /** Timezone offset in minutes. */
  tz: number;
};

const DateTuple = Record<DateTupleProps>({unix: 0, tz: 0});
type DateTuple = RecordOf<DateTupleProps>;

/** Mutable commit state. */
type CommitStateProps = {
  rev: Rev;
  /** Original hashes. Used for "predecessor" information. */
  originalNodes: ImSet<Hash>;
  /**
   * Unique identifier within the stack. Useful for React animation.
   *
   * Note this should not be a random string, since we expect the CommitState[]
   * state to be purely derived from the initial ExportStack. It makes it easier
   * to check what commits are actually modified by just comparing CommitStates.
   * The "skip unchanged commits" logic is used by `calculateImportStack()`.
   *
   * We use commit hashes initially. When there is a split or add a new commit,
   * we assign new keys in a predicable (non-random) way. This property is
   * never empty, unlike `originalNodes`.
   */
  key: string;
  author: Author;
  date: DateTuple;
  /** Commit message. */
  text: string;
  /**
   * - hash: commit hash is immutable; this commit and ancestors
   *   cannot be edited in any way.
   * - content: file contents are immutable; commit hash can change
   *   if ancestors are changed.
   * - diff: file changes (diff) are immutable; file contents or
   *   commit hash can change if ancestors are changed.
   * - none: nothing is immutable; this commit can be edited.
   */
  immutableKind: 'hash' | 'content' | 'diff' | 'none';
  /** Parent commits. */
  parents: List<Rev>;
  /** Changed files. */
  files: ImMap<RepoPath, FileState>;
};

export const CommitState = Record<CommitStateProps>({
  rev: 0,
  originalNodes: ImSet(),
  key: '',
  author: '',
  date: DateTuple(),
  text: '',
  immutableKind: 'none',
  parents: List(),
  files: ImMap(),
});
export type CommitState = RecordOf<CommitStateProps>;

/**
 * Similar to `ExportFile` but `data` can be lazy by redirecting to a rev in a file stack.
 * Besides, supports "absent" state.
 */
type FileStateProps = {
  data: string | Base85 | FileIdx;
  /** If present, this file is copied (or renamed) from another file. */
  copyFrom?: RepoPath;
  /** 'x': executable. 'l': symlink. 'm': submodule. */
  flags?: string;
};

type Base85Props = {dataBase85: string};

const Base85 = Record<Base85Props>({dataBase85: ''});
type Base85 = RecordOf<Base85Props>;

const FileState = Record<FileStateProps>({data: '', copyFrom: undefined, flags: ''});
type FileState = RecordOf<FileStateProps>;

type FileStackIndex = number;

type FileIdxProps = {
  fileIdx: FileStackIndex;
  fileRev: Rev;
};

type CommitIdxProps = {
  rev: Rev;
  path: RepoPath;
};

const FileIdx = Record<FileIdxProps>({fileIdx: 0, fileRev: 0});
type FileIdx = RecordOf<FileIdxProps>;

const CommitIdx = Record<CommitIdxProps>({rev: -1, path: ''});
type CommitIdx = RecordOf<CommitIdxProps>;

const ABSENT_FLAG = 'a';

/**
 * Represents an absent (or deleted) file.
 *
 * Helps simplify `null` handling logic. Since `data` is a regular
 * string, an absent file can be compared (data-wise) with its
 * adjacent versions and edited. This makes it easier to, for example,
 * split a newly added file.
 */
export const ABSENT_FILE = FileState({
  data: '',
  flags: ABSENT_FLAG,
});
