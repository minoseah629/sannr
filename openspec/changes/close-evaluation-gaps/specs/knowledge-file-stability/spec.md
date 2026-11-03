## ADDED Requirements

### Requirement: Unchanged outcomes do not rewrite committed knowledge

A captured request SHALL NOT change the committed knowledge file when its status, response shape, outcome and contract digest match the operation's newest retained observation.

#### Scenario: Identical request is repeated

- **WHEN** a committed operation is requested again with an unchanged result
- **THEN** the knowledge file stays byte-identical

#### Scenario: Status changes

- **WHEN** the same request returns a different status
- **THEN** a new observation is recorded

#### Scenario: Response shape changes

- **WHEN** the response gains or loses a field, or a field changes type
- **THEN** a new observation is recorded

### Requirement: Local evidence and receipts stay complete

Every executed request SHALL still write private local evidence, and its capture receipt SHALL state truthfully whether committed knowledge changed.

#### Scenario: Committed write is skipped

- **WHEN** an unchanged outcome skips the committed write
- **THEN** private evidence is written and the receipt says no committed change was made

### Requirement: Damaged knowledge files are reported by name

A reader SHALL report a knowledge file containing merge conflict markers or invalid JSON with a named error, and MUST NOT present it as an operation without history.

#### Scenario: File has conflict markers

- **WHEN** `show` reads a knowledge file containing unresolved conflict markers
- **THEN** it reports a named error identifying the file and does not report `history-unavailable`

### Requirement: Branches with unchanged outcomes merge cleanly

Two branches that repeat a committed request with an unchanged outcome SHALL NOT produce a change to the knowledge file that can conflict.

#### Scenario: Same operation called on two branches

- **WHEN** two branches each repeat the same committed request with an unchanged outcome and are merged
- **THEN** git reports no conflict in the knowledge file
