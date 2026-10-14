/**
 * Obligations for every original Electron journey, before fixture migration.
 *
 * Original path + expanded title is the stable identity. Assertion line numbers
 * refer to the immutable Git revision below, including shared helper assertions.
 * `planned` and a target mapping do not mean passed or covered. A delivery gate
 * must resolve every target and require actual non-skipped results. Deterministic
 * evidence never substitutes for a real business target except the user-approved
 * context_limit negative branch, which retains its exact original protocol test.
 * Fixed-scale persistence,
 * IPC and resource budgets remain business obligations even in a UI fixture.
 */
export type E2EMigrationClassification =
  | 'ui'
  | 'metadata-business'
  | 'real-native'
  | 'business+deterministic'

export interface E2EMigrationTarget {
  project: 'ui' | 'real' | 'deterministic'
  path: string
  title: string
}

export interface E2EAssertionGroup {
  originalAssertionLines: readonly number[]
  evidence: 'ui' | 'real' | 'deterministic' | 'real+deterministic'
  requirement: string
}

export interface E2EMigrationCase {
  originalPath: string
  originalTitle: string
  currentTitle?: string
  contractUpdates?: readonly {
    originalLine: number
    reason: string
    replacementAssertions: readonly string[]
  }[]
  classification: E2EMigrationClassification
  status: 'planned'
  targets: readonly E2EMigrationTarget[]
  assertionGroups: readonly E2EAssertionGroup[]
  realChecks: readonly string[]
  /** A mapped test may cover only part of an obligation; this blocks real acceptance. */
  pendingRealChecks: readonly string[]
  implementationNotes: readonly string[]
  deterministicChecks: readonly string[]
}

export const e2eMigrationBaseline = {
  revision: '6fade3636a7d77060ec4b35a50cdd764e3726228',
  specCount: 21,
  caseCount: 54,
  assertionSiteCount: 631,
} as const

/** Separately accepted 2026-10-06 increment; it cannot dilute the immutable baseline. */
export const e2eBusinessExpansionTargets: ReadonlyArray<E2EMigrationTarget & { area: string }> = [
  {
    area: 'workspace-changes',
    project: 'real',
    path: 'tests/e2e/real-workspace-changes.spec.ts',
    title:
      'real Claude edits preserve native versions and whole-card Undo rejects conflicts without partial writes',
  },
  {
    area: 'workspace-changes',
    project: 'real',
    path: 'tests/e2e/real-workspace-changes.spec.ts',
    title: 'real Codex applied patch remains reviewable while unavailable history disables Undo',
  },
  ...(['codex', 'claude'] as const).flatMap((agent) => [
    {
      area: 'stop',
      project: 'real' as const,
      path: 'tests/e2e/real-stop.spec.ts',
      title: `real ${agent} UI Stop preserves received text and unsent input before one explicit continuation${agent === 'codex' ? '; @all never starts its secondary' : ''}`,
    },
    {
      area: 'stop',
      project: 'real' as const,
      path: 'tests/e2e/real-stop.spec.ts',
      title: `real ${agent} UI Stop retires an unanswered native permission without executing its command`,
    },
    {
      area: 'stop',
      project: 'real' as const,
      path: 'tests/e2e/real-stop.spec.ts',
      title: `real ${agent} UI Stop interrupts its foreground command before the delayed filesystem effect`,
    },
  ]),
  {
    area: 'settings',
    project: 'real',
    path: 'tests/e2e/real-settings.spec.ts',
    title:
      'real defaults and Session overrides preserve frozen native settings, next-task routing and cold copies',
  },
  ...(['claude', 'codex'] as const).map((requester) => ({
    area: 'peer',
    project: 'real' as const,
    path: 'tests/e2e/real-peer-assistance.spec.ts',
    title: `real ${requester} structured peer request stays inert until Ask and executes the other Agent once`,
  })),
  {
    area: 'peer',
    project: 'real',
    path: 'tests/e2e/real-peer-assistance.spec.ts',
    title:
      'real Not now dismisses the proposal without a peer task and plain mention text cannot create one',
  },
]

/** Immutable expect sites, used to detect a dropped original assertion. */
export const e2eMigrationOriginalAssertions: Readonly<Record<string, readonly number[]>> = {
  'agent-capacity.spec.ts': [75, 76, 90, 93, 94, 102, 109, 140, 142, 156],
  'agent-handoff.spec.ts': [
    36, 39, 51, 54, 59, 60, 61, 79, 82, 88, 90, 93, 94, 95, 96, 125, 204, 209, 263, 265, 284, 323,
    347, 437, 438, 439, 440, 441, 442, 445, 446, 448, 451, 452, 453, 454, 455, 456, 470, 471, 472,
    473, 482, 483, 569, 570, 571, 573, 574, 575, 576, 583, 586, 592, 594, 597, 598, 599, 600, 603,
    614, 615, 623, 629, 635, 636,
  ],
  'agent-lifecycle.spec.ts': [
    34, 39, 42, 45, 51, 54, 63, 64, 65, 68, 100, 101, 102, 107, 108, 109, 117, 118, 145, 147, 148,
    158, 159, 160, 161, 186, 188, 189, 199, 200, 203, 206, 228, 229, 230, 233, 234, 235, 236, 255,
    256, 257, 258, 260, 261, 263, 278, 279, 280, 294, 295, 296, 298, 299, 300, 301, 316, 346, 354,
    365, 368, 383, 386, 387, 388, 407, 412, 414, 417, 418, 419, 424, 433, 434, 435, 436, 541,
  ],
  'anchored-comments.spec.ts': [25, 28, 31, 39, 58, 64, 65, 66, 158, 160, 192],
  'appearance.spec.ts': [
    19, 30, 31, 34, 35, 36, 37, 38, 45, 46, 47, 50, 51, 52, 55, 58, 60, 62, 74, 83, 84, 93, 103,
    110, 117, 122, 129, 135, 139, 140, 146, 148, 149, 150, 155, 156, 157, 159, 167, 168, 169, 177,
    180, 181, 182, 183, 184, 185, 194, 195, 196, 212, 215, 216, 217, 220, 246, 252, 260, 271, 291,
    292, 293, 294, 295, 296, 299, 302, 303, 306, 313,
  ],
  'conversation-error-recovery.spec.ts': [80, 113, 114, 115, 121, 122, 123, 124],
  'conversation-history-performance.spec.ts': [
    35, 36, 37, 38, 39, 40, 41, 44, 48, 49, 52, 53, 56, 57, 58, 61, 62, 63, 65, 75, 80, 85, 89, 91,
    92, 98, 128, 132, 152, 153, 174, 175, 191, 193, 197, 205, 216, 221, 222, 225, 229, 257, 261,
    262, 274, 275, 283, 284, 287, 290, 303, 333,
  ],
  'conversation-interest-performance.spec.ts': [
    61, 65, 66, 69, 71, 72, 89, 107, 108, 109, 111, 112, 118, 119, 120, 140, 142, 146, 156, 160,
    161, 162, 163, 171, 172, 173,
  ],
  'conversation-message-actions.spec.ts': [
    125, 127, 128, 136, 139, 140, 153, 159, 161, 169, 172, 173, 189, 190, 191, 196, 197, 199, 201,
    205, 207, 208, 209,
  ],
  'conversation-visibility.spec.ts': [
    92, 129, 131, 134, 136, 139, 149, 151, 154, 161, 164, 165, 175, 176, 177, 184, 199, 225, 228,
    230, 234, 238, 241, 242,
  ],
  'default-session-settings.spec.ts': [11, 14, 22, 27, 30, 31, 32, 35, 36],
  'foundation.spec.ts': [11, 12, 13, 14, 20, 52, 54, 55, 67, 99],
  'native-input-return.spec.ts': [
    61, 62, 98, 104, 107, 108, 111, 115, 116, 119, 124, 125, 128, 129, 147, 148, 149, 150, 163, 164,
    167, 170, 171, 172, 178, 179, 187, 188, 190, 191,
  ],
  'native-title.spec.ts': [47, 50, 57, 58, 62, 63, 64, 74, 75, 77, 78, 79],
  'project-catalog.spec.ts': [
    12, 13, 24, 25, 27, 29, 35, 39, 41, 42, 43, 45, 48, 49, 50, 52, 53, 54, 56, 68,
  ],
  'project-file-performance.spec.ts': [
    23, 24, 29, 34, 46, 47, 48, 50, 51, 53, 118, 120, 123, 127, 129, 136, 140, 141, 161, 166, 167,
    171, 172, 244,
  ],
  'runtime-preparation.spec.ts': [
    11, 12, 13, 14, 15, 16, 17, 19, 36, 37, 38, 41, 43, 56, 57, 58, 59, 60,
  ],
  'session-catalog-performance.spec.ts': [
    35, 36, 37, 38, 39, 40, 46, 54, 55, 56, 57, 59, 60, 61, 62, 86, 90, 92, 103, 104, 109, 138, 160,
    165, 166, 172, 174, 175, 176, 177, 213, 214, 219, 224, 226, 231, 235, 239, 242, 243, 245, 247,
  ],
  'session-fork.spec.ts': [
    294, 305, 306, 307, 309, 310, 316, 317, 340, 342, 343, 344, 345, 346, 353, 354, 355, 358, 388,
    389, 390, 392, 393, 394, 395, 396, 397, 398, 401, 402, 420, 421, 423, 424, 428, 429, 431, 432,
    456, 457, 459, 462, 463, 464, 465, 468, 470, 473, 479, 480, 482, 483, 488, 489, 491, 492, 493,
    494,
  ],
  'session-workspace.spec.ts': [
    19, 29, 35, 37, 41, 50, 53, 56, 62, 64, 68, 69, 71, 73, 75, 76, 77, 79, 80,
  ],
  'workspace-shell.spec.ts': [
    20, 23, 39, 56, 57, 58, 62, 71, 73, 76, 81, 84, 119, 120, 121, 125, 132, 134, 135, 138, 145,
  ],
}

type GroupPlan = readonly [
  from: number,
  through: number,
  evidence: E2EAssertionGroup['evidence'],
  requirement: string,
]
type RealPlan = readonly [
  file: 'native' | 'recovery' | 'performance',
  title: string,
  checks: readonly string[],
]

/** Exact registered titles, never a declaration that a test has passed. */
const implementedRealTargets: Readonly<
  Record<string, readonly (readonly [file: string, title: string])[]>
> = {
  'real CLIs report independent readiness and first-use gating': [
    ['real-environment.spec.ts', 'real CLIs report independent readiness and first-use gating'],
  ],
  'real configuration loss offers configuration recovery': [
    ['real-environment.spec.ts', 'real configuration loss offers configuration recovery'],
  ],
  'real configuration loss keeps existing work readable': [
    ['real-environment.spec.ts', 'real configuration loss keeps existing work readable'],
  ],
  'real @all runs ordered distinct Agents': [
    [
      'real-native.spec.ts',
      'real @all completes each Agent once and keeps ordered distinct response rows',
    ],
    [
      'real-routing.spec.ts',
      'real @all preserves distinct ordered rows while the second Agent waits for actual permission',
    ],
  ],
  'real explicit peer request does not replay completed primary': [
    ['real-context.spec.ts', 'real explicit Claude request after peer failure never reruns Codex'],
  ],
  'real context preparation failure preserves the draft': [
    [
      'real-context.spec.ts',
      'real large text exceeds the old Composer ceiling and preserves original Comments',
    ],
    ['real-source-read.spec.ts', 'real source-read refusal remains distinct and accepts no input'],
  ],
  'real background failure remains attached to its Run': [
    ['real-context.spec.ts', 'real background model failure remains attached to its Session Run'],
  ],
  'real fork refuses an absent peer without creating an empty side': [
    ['real-context.spec.ts', 'real Fork refuses a source without peer Native history'],
  ],
  'real handoff carries every intervening question and answer': [
    [
      'real-native.spec.ts',
      'real Claude follow-ups do not rerun Codex and both peer answers reach its next task',
    ],
  ],
  'real native current-call permission scope': [
    [
      'real-permissions.spec.ts',
      'real once permission executes its actual command and does not grant a new Session',
    ],
  ],
  'real native Session permission scope': [
    [
      'real-permissions.spec.ts',
      'real session permission executes its actual command and does not grant a new Session',
    ],
  ],
  'real five active Sessions reject a sixth without accepting input': [
    [
      'real-performance.spec.ts',
      'real five active Sessions reject a sixth without accepting input',
    ],
  ],
  'real sequential Sessions bound Adapter retention': [
    ['real-performance.spec.ts', 'real sequential Sessions bound Adapter retention'],
  ],
  'real native title and user rename survive cold resume': [
    [
      'real-native.spec.ts',
      'real Native first title accepts an IPC rename and cold resume preserves title and identity',
    ],
  ],
  'real rejected input restores frozen route and Comments into empty input': [
    [
      'real-input-return.spec.ts',
      'real occupied writer returns frozen Codex input and Comments; new draft empty',
    ],
  ],
  'real rejected input preserves a newer draft before frozen restoration': [
    [
      'real-input-return.spec.ts',
      'real occupied writer returns frozen Codex input and Comments; new draft preserved',
    ],
  ],
  'real missing native history rebuilds without replay': [
    [
      'real-recovery.spec.ts',
      'real Retry inspection of a moved Native record keeps the draft read-only and rebuilds once without replay',
    ],
  ],
  'real fork initializes configured models without generation': [
    [
      'real-recovery.spec.ts',
      'real Fork preserves both Native histories and the source draft through cold initialization without a Model task',
    ],
  ],
  'real inactive Session streaming retains completion and unread': [
    [
      'real-performance.spec.ts',
      'real inactive Session streaming retains completion, unread and Selection',
    ],
  ],
  'real Settings and minimization suppress progress without losing selection': [
    [
      'real-performance.spec.ts',
      'real inactive Session streaming retains completion, unread and Selection',
    ],
  ],
  'real uncertain delivery reconciles native evidence without resend': [
    [
      'real-lifecycle.spec.ts',
      'real lost ACK recovers the actual completed result without resend; warm inspection',
    ],
  ],
  'real completed native result can be recovered without generation': [
    [
      'real-lifecycle.spec.ts',
      'real lost ACK recovers the actual completed result without resend; cold inspection',
    ],
  ],
  'real absent evidence requires confirmed rebuild and new request': [
    [
      'real-lifecycle.spec.ts',
      'real absence and empty interruption never authorize replay or old-task rebuild',
    ],
  ],
  'real empty interrupted task stays hidden until new Send': [
    [
      'real-lifecycle.spec.ts',
      'real absence and empty interruption never authorize replay or old-task rebuild',
    ],
  ],
  'real completion releases input independently of title enrichment': [
    [
      'real-lifecycle.spec.ts',
      'real completion releases the Composer while Native title evidence is delayed',
    ],
  ],
  'real graceful quit persists received streaming text': [
    [
      'real-lifecycle.spec.ts',
      'real graceful quit preserves interrupted text through a new explicit request and cold restart',
    ],
  ],
  'real new task preserves earlier result across restart': [
    [
      'real-lifecycle.spec.ts',
      'real graceful quit preserves interrupted text through a new explicit request and cold restart',
    ],
  ],
  'real unreadable Retry evidence cannot start generation': [
    [
      'real-inspection-fault.spec.ts',
      'real silent Retry reads actual evidence without authorizing generation',
    ],
  ],
  'real committed fork retains frozen history while native initialization is incomplete': [
    [
      'real-initialization.spec.ts',
      'real unconfirmed Fork keeps the committed child locked and resumes the same candidate once after restart',
    ],
  ],
  'real fork restart resumes the original initialization candidate once': [
    [
      'real-initialization.spec.ts',
      'real unconfirmed Fork keeps the committed child locked and resumes the same candidate once after restart',
    ],
  ],
  'real unconfirmed rebuild checks candidate before confirmed replacement': [
    [
      'real-initialization.spec.ts',
      'real unconfirmed rebuild checks its actual candidate before one confirmed replacement and never replays',
    ],
  ],
}

const nativeTitleImplementationNote =
  'The actual CLI does not promise automatic first naming. The real case performs an owned Native rename, a second explicitly requested task to import the name, then a third cold-resume task to preserve the user title. Original automatic naming, ordering and exact two-task behavior remain unchanged in the deterministic protocol case; the real case does not claim that vendor behavior.'

const realImplementationNotes: Readonly<Record<string, readonly string[]>> = {
  'real @all runs ordered distinct Agents': [
    'The actual Claude Bash permission request holds the second Agent pending after the real Codex task completes. Pending ordered distinct rows are observed before approving actual command effects; no synthetic reply or delay supplies that state.',
  ],
  'real context preparation failure preserves the draft': [
    'Source-read coverage faults the fixture-owned SQLite source identity storage type from TEXT to BLOB after a genuine Claude reply. Actual Main hydration produces CONTEXT_UNAVAILABLE, preserves the draft, accepts no Message/Run and leaves Native history unchanged; original bytes and hashes are restored in finally. This verifies unreadable source handling, not the original metadata/body concurrent-read race.',
  ],
  'real explicit peer request does not replay completed primary': [
    'The actual peer process failure uses the public interrupted contract. The deterministic failure_once case retains its original exact failure presentation and protocol accounting; the real target proves primary identity/task retention and explicit-only peer continuation.',
  ],
  'real background failure remains attached to its Run': [
    'On 2026-10-06 the user accepted protocol-only evidence for this context_limit negative branch. The unchanged original protocol case verifies the exact failure kind and one-Toast behavior. The real companion separately verifies actual interrupted/transient_transport Run identity and background Session activity; it does not claim a real context_limit rejection. An actual small-window experiment completed successfully and is not rejection evidence.',
  ],
  'real native Session permission scope': [
    'CLI 0.159.2 disables request_permissions_tool by default. Only the owned test copy enables that capability; original user configuration/auth/model source files remain unchanged. The real native permission-tool Session grant executes the requested effect and a different Native Session asks again. This does not claim the original default command acceptForSession action or exact wire enum; those assertions remain unchanged in the deterministic protocol case.',
  ],
  'real graceful quit persists received streaming text': [
    'The actual streaming text is retained as a nonempty incomplete Message through graceful quit. Restart alone starts no task; Native inspection, if required, is followed by exactly one explicit new Send. The old Message ID, content and hash survive that task and another cold restart. This extended target requires a new real run; it is not satisfied by the old completed-title case.',
  ],
  'real new task preserves earlier result across restart': [
    'The mapped graceful-quit target preserves an actual incomplete prior body, not merely a completed reply. It checks the same Message ID, unchanged content/hash, two actual Native task starts, both visible bodies and cold persistence. The extended case remains unverified without new execution results.',
  ],
  'real unreadable Retry evidence cannot start generation': [
    'The target blocks actual Native inspection traffic. Its first real run exposed a runner expectation of CHECK_FAILED while the actual public error was RECOVERY_REQUIRED; that expectation was corrected and requires a real rerun. Listing or this mapping does not prove the corrected case has passed.',
  ],
}

function journey(
  file: string,
  title: string,
  classification: E2EMigrationClassification,
  groups: readonly GroupPlan[],
  real?: RealPlan,
  deterministicChecks: readonly string[] = [],
): E2EMigrationCase {
  const originalPath = `tests/e2e/${file}`
  const revisedCommentLimit =
    file === 'anchored-comments.spec.ts' &&
    title === 'keeps a ten-Comment bundle intact and reports the eleventh attempt as a warning'
  const currentTitle = revisedCommentLimit
    ? 'preserves an eleven-Comment draft bundle across restart without the retired ten-item limit'
    : title
  // These fixed-scale cases use real Electron/IPC/storage/file operations in a
  // real CLI profile. Their workload does not require artificial model turns.
  const directReal =
    [
      'appearance.spec.ts',
      'conversation-history-performance.spec.ts',
      'session-catalog-performance.spec.ts',
      'project-file-performance.spec.ts',
    ].includes(file) ||
    (file === 'conversation-visibility.spec.ts' && title.startsWith('read Retry'))
  const project = directReal
    ? 'real'
    : classification === 'ui' || file === 'runtime-preparation.spec.ts'
      ? 'ui'
      : classification === 'metadata-business'
        ? 'real'
        : 'deterministic'
  const targets: E2EMigrationTarget[] = [{ project, path: originalPath, title: currentTitle }]
  const implemented = real ? implementedRealTargets[real[1]] : undefined
  if (implemented && !directReal)
    for (const [targetFile, targetTitle] of implemented)
      targets.push({ project: 'real', path: `tests/e2e/${targetFile}`, title: targetTitle })
  return {
    originalPath,
    originalTitle: title,
    ...(file === 'workspace-shell.spec.ts' && title.startsWith('resizes and collapses')
      ? {
          contractUpdates: [
            {
              originalLine: 39,
              reason:
                'The existing ProjectNavigation exposes Rename Project plus the Project name as its accessible action label. Retain the original visible Project obligation and additionally require its exact displayed name; no layout or focus assertion is waived.',
              replacementAssertions: [
                "expect(window.getByRole('button', { name: 'Rename Project layout-project', exact: true })).toBeVisible()",
                "expect(window.getByRole('button', { name: 'Rename Project layout-project', exact: true })).toHaveText('layout-project')",
              ],
            },
          ],
        }
      : {}),
    ...(revisedCommentLimit
      ? {
          currentTitle,
          contractUpdates: [
            {
              originalLine: 64,
              reason:
                'The accepted Batch/Comment contract removed the independent ten-draft quota; the eleventh draft must produce no warning.',
              replacementAssertions: [
                `expect(window.locator('[data-pact-toast-tone="warning"]')).toHaveCount(0)`,
              ],
            },
            {
              originalLine: 65,
              reason: 'The normal Comment editor remains available for the eleventh draft.',
              replacementAssertions: [
                `expect(window.getByRole('heading', { name: 'New comment' })).toBeVisible()`,
              ],
            },
            {
              originalLine: 66,
              reason:
                'All eleven drafts survive creation and cold restart; packages/contracts/src/anchored-comments.ts retains the separate 24-item transport bound.',
              replacementAssertions: [
                `expect(drafts).toHaveCount(11)`,
                `expect(drafts).toHaveCount(11)`,
              ],
            },
          ],
        }
      : {}),
    classification,
    status: 'planned',
    targets,
    assertionGroups: groups.map(([from, through, evidence, requirement]) => ({
      originalAssertionLines: (e2eMigrationOriginalAssertions[file] ?? []).filter(
        (line) => line >= from && line <= through,
      ),
      evidence,
      requirement,
    })),
    realChecks:
      project === 'real'
        ? groups.filter((group) => group[2] !== 'ui').map((group) => group[3])
        : (real?.[2] ?? []),
    pendingRealChecks: real && !directReal && !implemented ? real[2] : [],
    implementationNotes:
      file === 'native-title.spec.ts'
        ? [nativeTitleImplementationNote]
        : file === 'agent-lifecycle.spec.ts' &&
            title === 'an oversized Agent event shows its explicit bounded failure state'
          ? [
              'The immutable original case has only three UI assertions over a seeded size-error state: notice visible, Reexecute absent and Composer enabled. It never dispatches an oversized event or measures a budget. UI fake data is sufficient for that original scope; this mapping claims no actual runtime budget trigger.',
            ]
          : real
            ? (realImplementationNotes[real[1]] ?? [])
            : [],
    deterministicChecks:
      file === 'native-title.spec.ts'
        ? [...deterministicChecks, nativeTitleImplementationNote]
        : deterministicChecks,
  }
}

export const e2eMigrationCases: readonly E2EMigrationCase[] = [
  journey(
    'foundation.spec.ts',
    'starts the Project Empty State and preserves the appearance foundation',
    'ui',
    [
      [1, 19, 'ui', 'Empty State has Add/Settings actions and no navigation toggle.'],
      [
        20,
        98,
        'ui',
        'Light/dark tokens retain exact canvas, surface, text, Agent, diff, status and focus colors; Settings navigation receives keyboard focus.',
      ],
      [99, 120, 'ui', 'Minimum viewport has no horizontal document overflow.'],
    ],
  ),
  journey(
    'workspace-shell.spec.ts',
    'resizes and collapses the Project navigation without squeezing its content',
    'ui',
    [
      [
        1,
        41,
        'ui',
        'Helpers establish native content size, viewport and visible selected Project.',
      ],
      [
        42,
        70,
        'ui',
        'Navigation/center are visible, separator width is 1px and keyboard resize changes width.',
      ],
      [
        71,
        89,
        'ui',
        'Collapse preserves inner width and toggle focus; reopening restores width without a context panel.',
      ],
    ],
  ),
  journey(
    'workspace-shell.spec.ts',
    'keeps Project navigation left of the workspace at the minimum supported width',
    'ui',
    [
      [
        1,
        41,
        'ui',
        'Helpers establish native content size, viewport and visible selected Project.',
      ],
      [
        91,
        124,
        'ui',
        'Navigation starts at x=0, remains left of center and document scroll stays zero.',
      ],
      [
        125,
        170,
        'ui',
        'Collapse removes separator width and moves center to x=0; reopen restores navigation without horizontal overflow.',
      ],
    ],
  ),
  journey(
    'default-session-settings.spec.ts',
    'saves first-use defaults and reopens the singleton from Settings',
    'metadata-business',
    [
      [
        1,
        30,
        'real',
        'Real first-use readiness leads to saving Codex primary, rounds=4 and repair attempts=3; same-profile restart skips onboarding.',
      ],
      [
        31,
        45,
        'real',
        'Production Settings restores Codex primary/rounds=4; unchanged defaults cannot be saved and use default cursor.',
      ],
    ],
  ),
  journey(
    'project-catalog.spec.ts',
    'adds, restores, collapses, archives, and re-adds a local Project',
    'metadata-business',
    [
      [
        1,
        36,
        'real',
        'Add a real isolated Git Project, collapse/expand and restart with one persistent Catalog identity.',
      ],
      [37, 46, 'ui', 'Archive actions have hover opacity, icon size, keyboard focus and no menu.'],
      [
        47,
        80,
        'real',
        'Archive returns Empty State and a top notice without View; Undo restores it and re-add restores the archived identity.',
      ],
    ],
  ),
  journey(
    'session-workspace.spec.ts',
    'keeps Project context while creating, reopening, archiving, and restoring a Session',
    'metadata-business',
    [
      [1, 21, 'real', 'Production picker adds both real isolated Projects.'],
      [
        22,
        64,
        'real',
        'Cancel/create retain Project context; only the selected Project owns the Session; cold restart reopens it.',
      ],
      [65, 72, 'ui', 'Archive control has hover visibility, icon size and keyboard focus.'],
      [
        73,
        90,
        'real',
        'Archive removes Session; top Undo notice without View restores its identity.',
      ],
    ],
  ),
  journey(
    'anchored-comments.spec.ts',
    'persists a Message Comment draft and restores its Composer chip after restart',
    'metadata-business',
    [
      [
        1,
        45,
        'real',
        'A real native-backed source creates an anchored Comment draft and restores the same Composer chip after restart.',
      ],
      [
        150,
        180,
        'real',
        'Source Session and persisted source Message open through production reads.',
      ],
      [
        181,
        200,
        'ui',
        'Selection exposes Comment action, release outside works and Composer focus dismisses it.',
      ],
    ],
  ),
  journey(
    'anchored-comments.spec.ts',
    'keeps a ten-Comment bundle intact and reports the eleventh attempt as a warning',
    'metadata-business',
    [
      [
        47,
        75,
        'real',
        'Historical ten-draft quota revised by the accepted Batch/Comment contract: ten drafts remain intact; the eleventh opens the editor without a quota warning, and all eleven survive cold restart. Three exact replacement obligations are recorded in contractUpdates.',
      ],
      [
        150,
        180,
        'real',
        'Source Session and persisted source Message open through production reads.',
      ],
      [181, 200, 'ui', 'Selection exposes Comment action before testing the limit.'],
    ],
  ),
  journey(
    'appearance.spec.ts',
    'previews and persists global Appearance settings across a real restart',
    'metadata-business',
    [
      [
        1,
        60,
        'ui',
        'Settings replaces Empty State, hides context and reflects theme/material choices and actual native fallback.',
      ],
      [
        61,
        73,
        'real',
        'Production appearance IPC stores requested dark/translucent/85 settings in isolated profile.',
      ],
      [
        74,
        129,
        'ui',
        'Strength mapping yields exact CSS alpha, panel colors, contrast and control state.',
      ],
      [
        130,
        164,
        'real',
        'Stored opacity agrees with mapping, restart restores committed settings and Restore defaults resets durable request.',
      ],
      [
        165,
        200,
        'ui',
        'Back returns focus; narrow native window stays bounded without context overlay.',
      ],
    ],
  ),
  journey(
    'appearance.spec.ts',
    'restores the last committed appearance when a save fails',
    'metadata-business',
    [
      [1, 19, 'ui', 'Appearance Settings helper opens expected heading.'],
      [
        203,
        230,
        'real',
        'Local write failure alerts, rolls radio/theme back and production IPC still returns the prior system request.',
      ],
    ],
  ),
  journey(
    'appearance.spec.ts',
    'macOS page Alpha follows transparency strength while Solid stays opaque',
    'ui',
    [
      [1, 19, 'ui', 'Appearance Settings helper opens expected heading.'],
      [
        231,
        280,
        'ui',
        'Supported macOS backing is translucent; capturePage alpha is below 255 and slider CSS follows strength.',
      ],
      [
        281,
        320,
        'ui',
        'Light/dark alpha ordering and numeric tolerances follow strength; Solid is exactly opaque.',
      ],
    ],
  ),
  journey(
    'conversation-message-actions.spec.ts',
    'keeps message actions with their bubble and collapses a long Work log from its foot',
    'ui',
    [
      [
        1,
        160,
        'ui',
        'Actions align to own bubbles with exact spacing, timestamp and hover opacity.',
      ],
      [
        161,
        191,
        'ui',
        'Copy preserves full text; actions linger then hide; Selection exposes correct Comment icon.',
      ],
      [
        192,
        230,
        'ui',
        '50-step Work log expands, footer collapse is in viewport and collapsing removes all step DOM.',
      ],
    ],
  ),
  journey(
    'conversation-error-recovery.spec.ts',
    'a Message-row render fault leaves navigation and draft intact through one view remount',
    'ui',
    [
      [
        1,
        120,
        'ui',
        'Renderer timestamp fault shows recovery, retains navigation and hides raw fault text.',
      ],
      [
        121,
        140,
        'ui',
        'Try again restores source/draft, removes recovery and creates no duplicate user row.',
      ],
    ],
  ),
  journey(
    'runtime-preparation.spec.ts',
    'shows independent first-use readiness for both CLIs',
    'business+deterministic',
    [
      [
        1,
        25,
        'real+deterministic',
        'Both independent CLI identity/version/readiness rows appear and Continue requires both Ready.',
      ],
    ],
    [
      'native',
      'real CLIs report independent readiness and first-use gating',
      [
        'Probe actual isolated CLIs; assert their actual versions and independent Ready states before Continue.',
      ],
    ],
    ['Pinned fixture version strings and exact Ready presentation remain auxiliary.'],
  ),
  journey(
    'runtime-preparation.spec.ts',
    'uses configuration recovery instead of an irrelevant executable picker',
    'business+deterministic',
    [
      [
        26,
        40,
        'real+deterministic',
        'Authentication/setup failure offers API/login recovery without an irrelevant picker.',
      ],
      [41, 48, 'ui', 'Path-change control is hidden until Agent row hover.'],
    ],
    [
      'native',
      'real configuration loss offers configuration recovery',
      [
        'Remove only scenario Claude credentials, probe actual CLI and verify actionable setup state without importing host auth.',
      ],
    ],
    ['Exact authentication_required copy remains auxiliary if vendor readiness differs.'],
  ),
  journey(
    'runtime-preparation.spec.ts',
    'keeps returning work readable while Agent actions are gated',
    'business+deterministic',
    [
      [
        50,
        75,
        'real+deterministic',
        'Returning work remains readable while model actions are gated and Review setup stays available.',
      ],
    ],
    [
      'native',
      'real configuration loss keeps existing work readable',
      [
        'Open real persisted work with scenario-only missing/invalid configuration; keep history navigation and reject generation.',
      ],
    ],
    ['Exact Setup-required notice and data-agent-actions remain auxiliary.'],
  ),
  journey(
    'agent-handoff.spec.ts',
    '@all preserves ordered distinct Agent rows while the second response is pending',
    'real-native',
    [
      [
        25,
        53,
        'real',
        'Primary reply arrives while distinct unique peer rows exist; peer later replies.',
      ],
      [
        54,
        65,
        'real',
        'Order is Codex then Claude, one native task each, and Composer is released.',
      ],
      [125, 125, 'real', '@all route selection retains literal token before Send.'],
    ],
    [
      'native',
      'real @all runs ordered distinct Agents',
      [
        'Send @all with configured models; inspect persisted Run/native identities and ordered rows during peer execution; forbid duplicates.',
      ],
    ],
  ),
  journey(
    'agent-handoff.spec.ts',
    'a new explicit Claude request after @all does not rerun the confirmed Codex peer',
    'business+deterministic',
    [
      [
        68,
        100,
        'real+deterministic',
        'After peer failure, explicit Claude request adds only one peer result, retains one primary result and releases Composer without reexecute.',
      ],
      [125, 125, 'real', '@all route selection retains literal token before Send.'],
    ],
    [
      'recovery',
      'real explicit peer request does not replay completed primary',
      [
        'Interrupt owned real peer after primary completes; explicitly Send @claude and verify Codex native task count unchanged.',
      ],
    ],
    ['failure_once and exact fixture task counts remain auxiliary.'],
  ),
  journey(
    'agent-handoff.spec.ts',
    'supplies every intervening peer question and answer to the next Agent',
    'real-native',
    [
      [
        134,
        217,
        'real',
        'Next Agent receives all four intervening user/peer facts; context-supplied notice counts four Messages.',
      ],
    ],
    [
      'native',
      'real handoff carries every intervening question and answer',
      [
        'Generate both real Claude Q/A pairs with distinct markers; real Codex must receive all markers and four-message context.',
      ],
    ],
  ),
  journey(
    'agent-handoff.spec.ts',
    'size and source-read failures show distinct top Error Toasts without losing the draft',
    'business+deterministic',
    [
      [
        218,
        286,
        'real+deterministic',
        'Size/source-read refusals have different top errors, keep Composer text and persist zero rejected user Messages.',
      ],
    ],
    [
      'recovery',
      'real context preparation failure preserves the draft',
      [
        'Use real native-backed history; cause local size/source-read failure and verify no new native task or accepted user row.',
      ],
    ],
    ['Preserve both exact CONTEXT_TOO_LARGE/CONTEXT_UNAVAILABLE IPC responses and copies.'],
  ),
  journey(
    'agent-handoff.spec.ts',
    'a background context-window refusal shows one top Error Toast and keeps the failed Run',
    'business+deterministic',
    [
      [
        287,
        349,
        'deterministic',
        'User-approved protocol evidence: context_limit shows one top error and retains the failed Run and input.',
      ],
    ],
    [
      'recovery',
      'real background failure remains attached to its Run',
      [
        'Switch away during real execution, induce a real bounded external failure and retain its notification, Run identity and actual failure class.',
      ],
    ],
    [
      'The user accepted this one negative branch as protocol-only on 2026-10-06. All original context_limit and one-Toast assertions remain unchanged; real interruption evidence is a separate companion.',
    ],
  ),
  journey(
    'agent-handoff.spec.ts',
    'a missing Native Session preserves the draft, locks input, and rebuilds in place',
    'real-native',
    [
      [
        350,
        455,
        'real',
        'Missing history locks input/retains draft, creates one recovery region and no context before confirmation; confirmed Rebuild clears recovery.',
      ],
      [
        456,
        497,
        'real',
        'Rebuild generates nothing, is stable across restart/check, keeps original user Message and stores ready context with incremented binding generation/source count.',
      ],
    ],
    [
      'recovery',
      'real missing native history rebuilds without replay',
      [
        'Remove only completed real scenario history; Retry then confirm Rebuild; inspect new native identity/generation, no old task, retained draft/history and restart idempotence.',
      ],
    ],
  ),
  journey(
    'agent-handoff.spec.ts',
    'a failed candidate check offers one confirmed creation and never dispatches the old task',
    'business+deterministic',
    [
      [
        499,
        593,
        'real+deterministic',
        'Unconfirmed candidate offers Retry then explicit Rebuild with previous-attempt warning; no generation/creation before confirmation.',
      ],
      [
        594,
        615,
        'real+deterministic',
        'Confirmation creates one context without old task and restores unsent input outside Transcript with frozen primary route/installed state.',
      ],
      [
        616,
        650,
        'real+deterministic',
        'Original Message is hidden, failed Run remains not_sent and one completed Rebuild clears source chunks.',
      ],
    ],
    [
      'recovery',
      'real unconfirmed rebuild checks candidate before confirmed replacement',
      [
        'Interrupt real initialization after candidate creation; restart/check same candidate before replacement; verify durable input recovery without old dispatch.',
      ],
    ],
    ['Exact candidate failure/settings-read timing and not_sent seed remain auxiliary.'],
  ),
  ...(['once', 'session'] as const).map((choice) =>
    journey(
      'agent-lifecycle.spec.ts',
      `offers only current-call/Session actions and sends the exact ${choice} native response`,
      'real-native',
      [
        [
          1,
          76,
          'real',
          'Permission offers only call/Session actions, confirms Session scope, removes card after decision and dispatches one task.',
        ],
      ],
      [
        'native',
        `real native ${choice === 'once' ? 'current-call' : 'Session'} permission scope`,
        [
          `Trigger actual Ask-mode command approval; choose ${choice}, verify bounded file effect and no approval grant in a new native Session.`,
        ],
      ],
      [
        `Exact ${choice === 'session' ? 'acceptForSession' : 'accept'} response enum and fixture task count remain protocol evidence.`,
      ],
    ),
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'provider completion releases the Composer while title enrichment is silent',
    'business+deterministic',
    [
      [
        77,
        124,
        'real+deterministic',
        'Two explicit tasks reuse context and release/clear input independently of title read; restart keeps both results and enabled Composer.',
      ],
    ],
    [
      'native',
      'real completion releases input independently of title enrichment',
      [
        'Complete two real requests on same native context; verify completion releases input before enrichment and cold restart keeps identity/results.',
      ],
    ],
    ['Deliberately silent thread/read and 1-second release deadline remain deterministic.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'Retry check recovers a lost acknowledgement from native evidence without resending',
    'business+deterministic',
    [
      [
        125,
        167,
        'real+deterministic',
        'One accepted input settles execution; Retry restores native result, unlocks input and creates no second task.',
      ],
    ],
    [
      'recovery',
      'real uncertain delivery reconciles native evidence without resend',
      [
        'Drop real CLI ACK/event after dispatch without fabricating response; Retry reads matching native evidence and restores one task.',
      ],
    ],
    ['Exact lost_ack_recovered timing/output identity remain auxiliary.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'absence cannot authorize replay: Retry and confirmed Rebuild start no old task',
    'business+deterministic',
    [
      [
        168,
        237,
        'real+deterministic',
        'Absent evidence cannot replay; confirmed Rebuild generates nothing, repeated nonce is idempotent and only new Send adds a task; original input stays singular.',
      ],
      [541, 541, 'real', 'New-task helper requires enabled Composer.'],
    ],
    [
      'recovery',
      'real absent evidence requires confirmed rebuild and new request',
      [
        'Remove scenario evidence after real interruption; Retry, confirm Rebuild and repeat nonce; compare identities/counts before explicit fresh Send.',
      ],
    ],
    ['Exact lost_ack_absent_then_retry and thread-start accounting remain auxiliary.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'Retry restores a confirmed completed result without creating another request',
    'business+deterministic',
    [
      [
        247,
        269,
        'real+deterministic',
        'Retry-only recovery locks input until inspection, restores completed native result and generates zero new tasks.',
      ],
    ],
    [
      'recovery',
      'real completed native result can be recovered without generation',
      [
        'Use completed real native evidence with only Pact ACK loss; Retry must add no native turn/provider request.',
      ],
    ],
    ['Seeded unknown-delivery presentation and zero modelStarts remain auxiliary.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'an oversized Agent event shows its explicit bounded failure state',
    'ui',
    [
      [
        270,
        286,
        'ui',
        'A seeded size-error UI state displays the notice, offers no Reexecute and keeps Composer enabled.',
      ],
    ],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'an empty interrupted response stays hidden and only a new message starts another task',
    'business+deterministic',
    [
      [
        287,
        307,
        'real+deterministic',
        'Empty interruption has no Agent bubble/duplicate label; only explicit new Send adds one visible answer while old user input remains once.',
      ],
      [541, 541, 'real', 'New-task helper requires enabled Composer.'],
    ],
    [
      'recovery',
      'real empty interrupted task stays hidden until new Send',
      [
        'Terminate owned actual CLI before assistant text; inspect interrupted state and verify only explicit new Send starts next task.',
      ],
    ],
    ['Exact empty-output crash event and visibility counts remain auxiliary.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'graceful quit flushes an unpublished Delta before shutdown acknowledgement and restart',
    'business+deterministic',
    [
      [
        308,
        374,
        'real+deterministic',
        'Pending received Delta flushes before quit ACK; inputs/text/interrupted status persist and restart offers same content plus Retry.',
      ],
      [541, 541, 'real', 'New-task helper requires enabled Composer.'],
    ],
    [
      'recovery',
      'real graceful quit persists received streaming text',
      [
        'Quit during received real text, restart same profile and compare durable text/Run/recovery with zero additional model request.',
      ],
    ],
    ['Exact pendingStreamItems=1 unpublished race/flush ordering remain deterministic.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'a silent Retry check cannot authorize generation and exposes checked Rebuild recovery',
    'business+deterministic',
    [
      [
        375,
        394,
        'real+deterministic',
        'Silent inspection settles to checked Rebuild, produces no reply/task and keeps input locked.',
      ],
    ],
    [
      'recovery',
      'real unreadable Retry evidence cannot start generation',
      [
        'Block owned real inspection transport; require finite settlement/recovery with zero generation or replay.',
      ],
    ],
    ['Silent inspection RPC and 20-second deadline remain auxiliary.'],
  ),
  journey(
    'agent-lifecycle.spec.ts',
    'a new explicit request preserves the previous result and both histories survive restart',
    'real-native',
    [
      [395, 413, 'ui', 'Prior incomplete result stays visible with bubble/action spacing.'],
      [
        414,
        450,
        'real',
        'One new explicit task adds one input/result, preserves each earlier input/result once and cold restart creates no task.',
      ],
      [541, 541, 'real', 'New-task helper requires enabled Composer.'],
    ],
    [
      'recovery',
      'real new task preserves earlier result across restart',
      [
        'Generate real prior output then interrupt; explicitly Send one new task; verify both native/Pact histories across restart without replay.',
      ],
    ],
  ),
  journey(
    'agent-capacity.spec.ts',
    'five Sessions run while the sixth gets a warning and keeps its draft',
    'real-native',
    [
      [
        54,
        119,
        'real',
        'Five real tasks remain active; sixth warns, retains draft, persists no input and leaves active=5/preparing=0/slots=5.',
      ],
    ],
    [
      'native',
      'real five active Sessions reject a sixth without accepting input',
      [
        'Hold five actual executions with an owned bounded transport/tool barrier; reject sixth before durable/native acceptance and release all resources.',
      ],
    ],
  ),
  journey(
    'agent-capacity.spec.ts',
    'sequential Sessions keep at most five Adapter slots',
    'real-native',
    [
      [
        120,
        180,
        'real',
        'Ten sequential actual tasks each settle to zero active executions and slots<=5 after every acquisition.',
      ],
    ],
    [
      'native',
      'real sequential Sessions bound Adapter retention',
      [
        'Run ten real Session contexts sequentially; measure slot high-water per acquisition and zero pending/active resources after settlement.',
      ],
    ],
  ),
  journey(
    'native-title.spec.ts',
    'keeps the Native first title, renames through IPC and preserves user title on cold resume',
    'real-native',
    [
      [
        1,
        64,
        'real+deterministic',
        'First native title populates Pact, native naming uses [Pact] Project/title and UI rename reaches thread/name/set.',
      ],
      [
        65,
        90,
        'real+deterministic',
        'Naming follows dispatch; cold restart and second explicit task retain user title/same context with only two total tasks.',
      ],
    ],
    [
      'native',
      'real native title and user rename survive cold resume',
      [
        'Complete a real source task, explicitly name its owned Native context, import that name with a second explicit task, rename through IPC, then cold-resume with a third explicit task; verify same Native identity and no additional generation. Automatic/two-task protocol expectations remain deterministic.',
      ],
    ],
  ),
  ...(['empty', 'preserved'] as const).map((draft) =>
    journey(
      'native-input-return.spec.ts',
      `Rebuild returns rejected Codex input and Comments with frozen routing; new draft ${draft}`,
      'business+deterministic',
      [
        [
          49,
          107,
          'real',
          'Real first reply supports Comment; failed second dispatch enters Rebuild with one task.',
        ],
        [
          108,
          150,
          'real+deterministic',
          draft === 'preserved'
            ? 'Confirmed Rebuild preserves newer input, disables restore until cleared, then installs exact frozen @codex body/Comment without dispatch.'
            : 'Confirmed Rebuild restores exact frozen @codex body/Comment into empty input without dispatch.',
        ],
        [
          151,
          172,
          'real',
          'Empty-input recovery survives restart; only explicit Enter adds task two and clears Composer.',
        ],
        [
          173,
          210,
          'real+deterministic',
          'DB retains one occupied failure/two completed Codex Runs, hidden original frozen input, old Comment linkage and recreated draft.',
        ],
      ],
      [
        'recovery',
        `real rejected input ${draft === 'empty' ? 'restores frozen route and Comments into empty input' : 'preserves a newer draft before frozen restoration'}`,
        [
          `Generate real source/Comment; cause actual owned native-writer conflict, confirm Rebuild, preserve ${draft} input and verify route/body/new Comment identity plus explicit-only generation.`,
        ],
      ],
      [
        'writer_rejected_once and exact native_session_occupied/not_sent accounting remain auxiliary.',
      ],
    ),
  ),
  journey(
    'session-fork.spec.ts',
    'rejects missing peer native history through the real Fork IPC without creating an empty side',
    'real-native',
    [
      [280, 308, 'ui', 'Only assistant replies offer Fork; control follows Copy and both exist.'],
      [
        309,
        327,
        'real',
        'Absent peer disables Create with actionable error and changes neither Session nor Run count.',
      ],
    ],
    [
      'native',
      'real fork refuses an absent peer without creating an empty side',
      [
        'Create actual Claude-only history/no Codex source; open Fork and verify no child, native fork or model request.',
      ],
    ],
  ),
  journey(
    'session-fork.spec.ts',
    'a committed fork survives startup with sidebar error, readable history and a locked Composer',
    'business+deterministic',
    [
      [
        328,
        368,
        'real+deterministic',
        'Committed child retains frozen peer prefix, locked input/Send, two continuation actions, error activity and four persisted Messages/Runs.',
      ],
    ],
    [
      'recovery',
      'real committed fork retains frozen history while native initialization is incomplete',
      [
        'Commit Fork from actual two-provider history, stop owned initialization before ready, restart and verify same child/prefix/actions and locked dispatch.',
      ],
    ],
    ['Exact precommitted error seed/four-Run count remain auxiliary.'],
  ),
  ...(['custom-fixture-one[1m]', 'custom-fixture-two'] as const).map((model) =>
    journey(
      'session-fork.spec.ts',
      `full Fork UI initializes both providers without a model turn and resolves ${model}`,
      'real-native',
      [
        [
          369,
          402,
          'real',
          'Dialog uses effective/requested model/effort/permission; native initialization closes dialog, keeps prefix and generates nothing.',
        ],
        [
          403,
          439,
          'real',
          'One native fork creates ready four-Message child; source retains draft; explicit continuation affects child only.',
        ],
      ],
      [
        'native',
        'real fork initializes configured models without generation',
        [
          'Generate both actual native histories, fork at real boundary and inspect configured model/effort/prefix; zero generation during initialization, source intact and child-only continuation.',
        ],
      ],
      [
        `Retain opaque ${model} resolution in deterministic test; real journey must use user-configured effective model rather than a fixture alias.`,
      ],
    ),
  ),
  journey(
    'session-fork.spec.ts',
    'failed initialization closes the create dialog and restart recovers the same candidate once',
    'business+deterministic',
    [
      [
        440,
        468,
        'real+deterministic',
        'Failure closes dialog; child shows one error/recovery and ready peer, locks input and retains original candidate identity.',
      ],
      [
        469,
        510,
        'real+deterministic',
        'Check-original performs no repeat settings read; restart preserves candidate; Continue clears recovery and resumes same candidate without second fork/generation.',
      ],
    ],
    [
      'recovery',
      'real fork restart resumes the original initialization candidate once',
      [
        'Interrupt actual initialization after candidate exists, check/restart/continue same candidate and verify no replacement native fork or generation.',
      ],
    ],
    ['fork_settings_once/settingsReads/exact two resumes remain protocol evidence.'],
  ),
  journey(
    'conversation-interest-performance.spec.ts',
    'suppresses inactive Session progress upstream while retaining completion, unread and latest content',
    'business+deterministic',
    [
      [
        1,
        88,
        'real',
        'Foreground gets progress/completion; switching Sessions keeps the other Composer available.',
      ],
      [
        89,
        117,
        'real+deterministic',
        'Inactive progress is suppressed upstream, zero complete reads/body Patches, background bytes<8KiB and unread completion.',
      ],
      [
        118,
        180,
        'real',
        'Return/reload restores durable text/unread; return during another task retains same Run/current progress without placeholder reset or duplicates.',
      ],
    ],
    [
      'performance',
      'real inactive Session streaming retains completion and unread',
      [
        'Use bounded real streaming/cadence barrier; inspect foreground/inactive bytes/counters, unread/reload and same-Run resumption.',
      ],
    ],
    ['Fixed 60-part cadence/exact counters/8KiB budget remain deterministic.'],
  ),
  journey(
    'conversation-visibility.spec.ts',
    'Settings and minimization pause progress without losing reading position or Selection',
    'business+deterministic',
    [
      [
        82,
        138,
        'real',
        'Settings removes interest while preserving selected source and reading offset.',
      ],
      [
        139,
        165,
        'real+deterministic',
        'Hidden/minimized progress is suppressed without publication growth; restore keeps Selection/result with zero full reads.',
      ],
      [
        166,
        190,
        'real',
        'Hide/show never duplicates inputs or changes Run; no position reset or Composer vertical scroll.',
      ],
    ],
    [
      'performance',
      'real Settings and minimization suppress progress without losing selection',
      [
        'Select real completed source while actual task streams; Settings/minimize/restore preserve quote/offset, interest counters and same native Run.',
      ],
    ],
    ['Fixed background_stream increments/ten-message geometry remain auxiliary.'],
  ),
  journey(
    'conversation-visibility.spec.ts',
    'read Retry never resends and hidden detail cancellation permits another expansion',
    'business+deterministic',
    [
      [
        191,
        245,
        'real+deterministic',
        'Hidden pending detail cancels/reexpands; read failure offers Retry loading, restores detail and retains exactly one original input.',
      ],
    ],
    [
      'performance',
      'real read retry and hidden detail cancellation never generate',
      [
        'Use actual native history/activity; delay only read transport, cancel via hide/show and Retry one read failure; native task/provider count must not grow.',
      ],
    ],
    ['Exact 500ms activity read delay/failure and large reasoning fixture remain auxiliary.'],
  ),
  journey(
    'conversation-history-performance.spec.ts',
    'opens a 10,000-Message Session through bounded pages and keeps large bodies bounded',
    'business+deterministic',
    [
      [
        25,
        41,
        'deterministic',
        '10k fixture measures bounded page/Patch bytes, snapshot/page scale, zero stream full reads and timings.',
      ],
      [
        42,
        97,
        'deterministic',
        '25-item page, bounded DOM/large preview/comments/latest 50 activity and 100-item older-window cap persist.',
      ],
      [
        98,
        173,
        'real+deterministic',
        'Committed IPC gap resynchronizes authoritative state and restores source/Selection within 2px.',
      ],
      [
        174,
        215,
        'ui',
        'Leaving source clears ordinary Selection; later gap follows new source and latest intent clears remaining Selection.',
      ],
      [216, 246, 'deterministic', 'Latest restores bounded 25-item page and mounted rows.'],
    ],
    [
      'performance',
      'real history resynchronization preserves bounded pages and selection',
      [
        'Generate actual reply/history, drop only committed IPC notification, force gap and verify source/text/Selection from authoritative bounded read.',
      ],
    ],
    [
      'Keep exact 10k/25/100/latest-50 workloads and byte budgets; real provider timing does not replace them.',
    ],
  ),
  journey(
    'conversation-history-performance.spec.ts',
    'Comment navigation mounts the exact offscreen source and preserves its selection while scrolling',
    'business+deterministic',
    [
      [
        247,
        302,
        'real+deterministic',
        'Reverse Comment read mounts exactly offscreen source, selects quote in viewport/pulses it, pins source/Selection and bounds DOM.',
      ],
      [
        303,
        340,
        'ui',
        'Resident-latest and long-message middle quotes navigate precisely and return to latest through keyboard/explicit intent.',
      ],
    ],
    [
      'performance',
      'real Comment navigation resolves actual native-backed source',
      [
        'Save real reply Comment, move source off resident page and reverse navigate; verify exact source/quote/hash, pinning and bounded DOM.',
      ],
    ],
    ['Keep message-50/9990/middle-large-body anchors and 100-row budget.'],
  ),
  journey(
    'session-catalog-performance.spec.ts',
    'loads five Sessions at a time and preserves activity and unread state after restart',
    'business+deterministic',
    [
      [
        26,
        64,
        'deterministic',
        'Five-item pages exclude archived, have stable revision/cursor/activity order and unread/error projection.',
      ],
      [
        65,
        110,
        'real+deterministic',
        'Unseen mark-read invalidates cursor; load-more rebases without dropping loaded entries and DOM stays bounded.',
      ],
      [
        111,
        184,
        'real+deterministic',
        'Settings returns revision=2 delta, mark-read persists and restart keeps unread=false/rounds=5/error with initial page reset.',
      ],
    ],
    [
      'performance',
      'real Catalog pages preserve activity and unread through restart',
      [
        'Real background completed/failed tasks project into paged Catalog; mutate unseen read/settings, restart and inspect stable identities/revision/activity.',
      ],
    ],
    ['Keep 1k Sessions x 10 entries, exact five-item pagination/rebasing and DOM budgets.'],
  ),
  journey(
    'session-catalog-performance.spec.ts',
    'bounds Project DOM and preserves keyboard focus after scrolling a large Catalog',
    'business+deterministic',
    [
      [
        185,
        241,
        'ui',
        '1k-Project DOM bounded at both ends; focus stays in navigation after scrolling and Tab.',
      ],
      [
        242,
        270,
        'real',
        'Keyboard Archive removes focused Project without menu and Undo restores identity.',
      ],
    ],
    [
      'performance',
      'real Catalog virtualized archive and Undo retain Project identity',
      [
        'Archive/Undo actual isolated Project through Catalog, verify durable identity and keyboard accessibility.',
      ],
    ],
    ['Keep 1k-Project overscan/focus top/end workload.'],
  ),
  journey(
    'project-file-performance.spec.ts',
    'keeps maximum-size plain files complete while mounting only viewport code rows',
    'business+deterministic',
    [
      [1, 29, 'deterministic', '100k-line file has viewport-bounded Monaco rows.'],
      [
        30,
        59,
        'real+deterministic',
        '900k-character line remains complete, caret reaches 800k/horizontal scroll, wrap works and close releases editor DOM.',
      ],
      [244, 244, 'real', 'Session opens before file links.'],
    ],
    [
      'performance',
      'real file preview preserves complete source and bounds DOM',
      [
        'Actual CLI reply links to actual isolated files; production preview preserves disk text/selection/wrap/close.',
      ],
    ],
    ['Keep exact 100k-line/900k-character/caret-800k/viewport bounds.'],
  ),
  journey(
    'project-file-performance.spec.ts',
    'recreates JSON language service across TypeScript and releases Workers after repeated views',
    'business+deterministic',
    [
      [
        60,
        147,
        'real+deterministic',
        'JSON worker creates/terminates/recreates across TypeScript; 100 views leave zero active Workers/editor DOM.',
      ],
      [244, 244, 'real', 'Session opens before file links.'],
    ],
    [
      'performance',
      'real file preview releases JSON and TypeScript workers',
      [
        'Open actual native-backed JSON/TS links, close/reopen and measure Worker creation/termination with zero live resources.',
      ],
    ],
    ['Keep exact 100-view retention and JSON worker count workload.'],
  ),
  journey(
    'project-file-performance.spec.ts',
    'applies the same Comment quote limit to LF-normalized CRLF files',
    'business+deterministic',
    [
      [
        148,
        180,
        'real+deterministic',
        'LF-normalized 20k CRLF characters allow Comment; extra normalized line warns and removes action.',
      ],
      [244, 244, 'real', 'Session opens before file links.'],
    ],
    [
      'performance',
      'real file Comment limit normalizes CRLF before counting',
      [
        'Open actual files via real reply links; select CRLF content and verify normalized Comment-limit response.',
      ],
    ],
    ['Keep exact 10k/10001-line CRLF and 20k-character boundary.'],
  ),
]
