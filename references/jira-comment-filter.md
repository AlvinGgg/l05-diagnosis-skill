# Jira Comment Filter

The Jira fetch script includes user comments and excludes likely IM/system/bot comments by default.

## Author Fields

Evaluate these Jira author fields together:

- `emailAddress`
- `name`
- `displayName`
- `key`
- `accountId`

The script lowercases and joins those values before applying filters.

## Default Exclusion Intent

Exclude comments from automation or relay accounts such as:

- IM bridge accounts.
- Jira/system automation.
- CI/CD bots.
- Orchestration or support automation accounts.
- no-reply/noreply accounts.

The default regex is intentionally conservative enough to avoid filtering normal users just because their email contains incidental letters.

## Override Rules

Use `--comment-exclude-regex` or `L05_JIRA_COMMENT_EXCLUDE_REGEX` when the local Jira instance has known automation account patterns.

Use `--comment-include-regex` when the issue requires comments from a specific requester or team.

If a filtered comment might materially change the diagnosis, mention that comments were filtered and rerun with a narrower override before making a strong claim.

## Output Expectations

The script returns:

- Included comments with author, timestamps, and normalized body.
- Filtered-out comment metadata and filter reason, without comment body by default.
- Included and filtered counts.

This lets the diagnosis cite user comments while still showing whether automation noise was removed.
