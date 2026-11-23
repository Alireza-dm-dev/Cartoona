# CI/CD (V0.1.56)

Continuous integration on every pull request, image publishing to GHCR on every
push to an integration branch, and a **gated** production deployment of the exact
tested images to the Ubuntu server, with automatic rollback of the application
images.

> **Status: automatic deployment is OFF.** It stays off until an admin sets two
> repository variables **and** root on the server records a GO decision. The
> production business-data cutover remains **NO-GO** (docs/PRODUCTION_CUTOVER.md
> section 16) and nothing here changes that: CI/CD never migrates, copies data,
> touches PostgreSQL, edits `.env.docker`, lifts `CARTOONA_WRITE_FREEZE`, changes
> Cloudflare or runs the Storage lockdown.

Contents: [1 Architecture](#1-architecture) · [2 CI](#2-ci-pull-requests-and-pushes) ·
[3 Images](#3-images-ghcr) · [4 Deployment](#4-deployment) · [5 Rollback](#5-rollback) ·
[6 Secrets and variables](#6-secrets-and-variables) · [7 Server setup](#7-server-setup-operator) ·
[8 GitHub setup](#8-github-setup-admin) · [9 Activation procedure](#9-activation-procedure) ·
[10 Server configuration review](#10-server-configuration-review-phase-7) ·
[11 Troubleshooting](#11-troubleshooting) · [12 Security model](#12-security-model) ·
[13 Known limitations](#13-known-limitations)

---

## 1. Architecture

```
 pull_request ─┐
               ├─► ci.yml ─► checks ──┐
 push (main,   │            test ─────┼─► images ─► (push only) GHCR :<sha>, recorded by digest
 integration) ─┘                      │                 │
                                      │                 ▼  only if DEPLOY_BRANCH + CARTOONA_DEPLOY_MODE
                                      └──────────► deploy (calls deploy.yml)
                                                        │ SSH, strict host key, forced command
                                                        ▼
                         cartoona-deploy@<SERVER_IP> ── sudo ──► /usr/local/sbin/cartoona-deploy (root-owned)
                                                        │  checks → pull digests → swap frontend/backend
                                                        │  → health → rollback on failure
                                                        ▼
                          /opt/cartoona: compose.yml + compose.production.yml + .env.docker (server only)
```

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | CI for PRs and pushes; builds, tests and (push only) publishes the images; calls the deploy workflow when enabled |
| `.github/workflows/deploy.yml` | The deployment job (reusable from CI; manual `workflow_dispatch` for status / preflight / deploy / rollback) |
| `deploy/compose.production.yml` | Production overlay: fixed local image tags, no build, frontend on `127.0.0.1:3000` |
| `deploy/server/cartoona-deploy` | Root-owned entry point on the server; the only privileged thing CI can run |
| `deploy/server/cartoona-deploy-ssh` | `authorized_keys` forced command; hands arguments to the script via `sudo -n` |
| `deploy/server/sudoers.cartoona-deploy` | Grants exactly that one program |
| `scripts/ci/*` | CI helpers: throwaway env, repository safety, image hygiene, smoke stack, test baseline |
| `.gitleaks.toml` | Secret-scan configuration (default rules + reviewed fixture allowlist) |
| `tsconfig.ci.json` | Typecheck scope of the shipped code (tests excluded; see 2) |

## 2. CI (pull requests and pushes)

Triggers: `pull_request` and `push` for `main` and `opencode/parent-portal-navigation`
(edit `on:` in `ci.yml` when the integration branch changes; GitHub does not allow
variables there). Default token permission: `contents: read`.

| Job | What runs |
|---|---|
| **checks** | gitleaks on the working tree · `scripts/ci/check-repo-safety.sh` (no tracked `.env`/key files, no private-key blocks, migration names `NNNN_*.sql` contiguous, **no existing migration modified/renamed/deleted** vs. the PR base or the previous push) · `npm ci` · `next typegen` · `tsc -p tsconfig.ci.json` · test-file typecheck (non-blocking, see below) · backend typecheck · ESLint · backend production build · Zero-Supabase-database runtime guard (`tests/unit/zero-supabase-db-static.test.ts`) |
| **test** | Throwaway PostgreSQL 17 via the compose `postgres` service (random masked credentials) · full Vitest suite with `CARTOONA_PLAIN_PG=docker` · baseline gate: **≥ 3442 passed, 0 failed, ≤ 37 skipped** locally; on a runner **3441 passed, 38 skipped**, because one approved test is skipped by design (`scripts/ci/check-test-baseline.mjs`, see below) |
| **images** (needs both) | Build frontend + backend for `linux/amd64` (Buildx, GHA cache) · image hygiene (non-root user, no `.env`/key files, no secret names in env or history) · **production-shaped smoke test** (`scripts/ci/smoke-stack.sh`): fresh PG17, all migrations, second migration run must apply nothing, restricted app login, backend + frontend from the overlay, `/health`, `/ready`, `/api/health`, `/api/creation-pricing`, write freeze ON, both services published on loopback only, frontend holds no database credential · **push only:** publish the tested images |
| **deploy** | Only on `push`, only for `vars.DEPLOY_BRANCH`, only when `vars.CARTOONA_DEPLOY_MODE` is `preflight` or `deploy` (section 4) |

Why the database is a compose service, not a job `services:` container: the
real-SQL suites locate it with `docker compose ps -q postgres` and run `psql` via
`docker exec` (no host client, credentials from the container). CI uses that
exact supported path. No test is pointed at Supabase: the runner has no Supabase
variables and no `.env.local`, and the stateful e2e specs (`tests/e2e`) are not
part of `npm test`.

**Test-file type errors (pre-existing, reported, not hidden).** `tsc` over the
whole repository fails with 29 errors in 8 files under `tests/` (V0.1.55; e.g.
`legacy-csrf-routes.test.ts`, `pricing-calculation.test.ts`,
`test-env-resolution.test.ts`). Vitest does not typecheck, so the suite is
unaffected, and the image build does not see `tests/`. CI therefore gates on the
shipped code (`tsconfig.ci.json`) and runs the full-repository check as a
non-blocking step that emits a warning annotation with the count. Fix those files,
then remove `continue-on-error` from that step.

**Next.js production build.** It runs inside the frontend image build — the
artifact that ships — rather than a second time on the host.

**Approved CI-only skip.** `test-env-resolution.test.ts` > "this checkout's .env.local: …"
validates the developer's own gitignored `.env.local`, so it is skipped on any
machine without that file, including every runner. The gate allows exactly that
test, by file and title, only when `CI=true`, and shifts the baseline by exactly
one. Any other skipped or missing test still fails. Add entries to `CI_ONLY_SKIPS`
only with explicit approval.

**Raising the baseline.** When tests are added, raise `MIN_PASSED` in
`scripts/ci/check-test-baseline.mjs` in the same PR. Never lower it to get green.

## 3. Images (GHCR)

| Image | Built from |
|---|---|
| `ghcr.io/alireza-dm-dev/cartoona-frontend` | `Dockerfile` |
| `ghcr.io/alireza-dm-dev/cartoona-backend` | `backend/Dockerfile` |

* Tag: the full commit SHA (`:<40-hex>`). **No `latest`.** Deployment always uses
  the digest (`@sha256:…`) recorded at push time, never a tag.
* Published only on `push`, only after `checks`, `test`, image hygiene and the
  smoke test passed, and only the very images those checks ran against (no rebuild).
* Platform `linux/amd64` (the server is x86_64).
* Build arguments are the three `NEXT_PUBLIC_*` repository **variables** and
  nothing else. Their SHA-256 is stored as the label
  `org.cartoona.next-public.sha256`; the server refuses an image whose baked
  values differ from its `.env.docker` (a wrong anon key would break sign-in for
  everyone).
* `.env*` never enters a build context (`.dockerignore`,
  `backend/Dockerfile.dockerignore`), and `scripts/ci/check-image.sh` re-checks
  the finished image.
* The `org.opencontainers.image.source` label links each package to this
  repository.

## 4. Deployment

### Gates (all must hold; each is independent)

| # | Gate | Who controls it | Effect when absent |
|---|---|---|---|
| 1 | CI succeeded for this commit (`deploy` `needs: images`) | — | no deploy job |
| 2 | Event is a `push` to `vars.DEPLOY_BRANCH` | repo admin | no deploy job |
| 3 | `vars.CARTOONA_DEPLOY_MODE` = `preflight` or `deploy` | repo admin | no deploy job |
| 4 | GitHub Environment `production` rules (reviewers / branch policy) **if the plan offers them** | repo admin | (not relied on) |
| 5 | Server: `/etc/cartoona/deploy-go` is a **single-use approval for this exact release**: commit SHA + both image digests match, not expired (at most 72 h from `approved_at`), not already used; file root-owned and protected | **root on the server** | `deploy` refused (exit 2); `preflight` still works and reports why (`go.valid_for_release=no`, `go.reason=…`) |
| 6 | Server: compose files identical to the commit; effective Compose config **and** running containers publish only on loopback; applied migrations identical to the commit; write freeze ON (always); current deployment healthy; `NEXT_PUBLIC_*` match; configuration files root-owned and not writable by others | the script | refused (exit 2), nothing changed |

Gate 5 is the authoritative GO record and does not depend on the GitHub plan:
naming an environment `production` is **not** an approval gate by itself.
An approval authorizes one deployment of one release and then it is spent, so an
old approval can never authorize a later release or a replay. Deleting the file
is an immediate kill switch.

### What a deploy does (`cartoona-deploy deploy`)

1. Lock (`flock`): one change at a time, also against a manual run. GitHub-side,
   `concurrency: cartoona-production` (never cancels a running deployment).
2. Validate every argument (only `ghcr.io/alireza-dm-dev/cartoona-{frontend,backend}@sha256:<64 hex>`;
   unknown, repeated or misplaced flags are refused).
3. **Check the GO approval first** (commit + both digests, expiry, unused), so an
   unapproved release is refused before anything is pulled.
4. Checks (gate 6), including the effective Compose ports and the running
   containers' real bindings, then current health (backend `/health` + `/ready`,
   frontend `/api/health` + `/api/creation-pricing`, write freeze in the running
   frontend). Database inspection runs with `default_transaction_read_only=on`.
5. Pull both digests (job token on stdin, throwaway Docker config, logout, delete).
   Verify the `NEXT_PUBLIC_*` label.
6. Re-check the approval (the pull can be slow), then **consume it atomically**
   (`mkdir` of `/var/lib/cartoona-deploy/consumed/<approval_id>`). From here on it
   is spent even if the deploy fails and is rolled back. Nothing running or
   tagged has been touched yet.
7. Record the running image IDs as `cartoona-{frontend,backend}:rollback` and the
   previous state file.
8. Point `cartoona-{frontend,backend}:deployed` at the new digests;
   `docker compose … up -d --no-deps --no-build --pull never --wait` **backend**,
   then **frontend**. PostgreSQL is never recreated, stopped or migrated.
9. Verify all probes again, including `CARTOONA_WRITE_FREEZE=1` inside the new
   frontend and loopback-only bindings of every container.
10. Success: write `/var/lib/cartoona-deploy/current.env` (commit SHA, digests,
   `approval_id`, `deployed_by=ci|admin`, time) and append to `history.log`.
   Failure: section 5.

The workflow then checks `vars.PUBLIC_HEALTH_URL` (through Cloudflare/Nginx) and
restores the previous images if it fails, and writes the job summary: commit,
branch, CI result, both digests, time, container health, every probe, rollback
status, plus the server's before/after state.

### Modes

| `CARTOONA_DEPLOY_MODE` | Effect on push to `DEPLOY_BRANCH` |
|---|---|
| unset / `off` | CI + publish only |
| `preflight` | Dry run: all checks + pull; **no container changes**, no GO needed |
| `deploy` | Full deployment (still requires the server GO record) |

Manual runs (`Actions → Deploy → Run workflow`): `status`, `preflight`, `deploy`
(digests + release SHA as inputs), `rollback`. GitHub lists manual runs only for
workflows that exist on the default branch (`main`), so these appear once this
work is merged there; the automatic path does not need that.

## 5. Rollback

**Automatic** (same run): if the new containers do not become healthy or any probe
fails, the script re-points `:deployed` at the `:rollback` images, restarts
backend and frontend, re-runs every probe, and exits **3** (rolled back, healthy)
or **4** (rollback failed too — operator now). A failed public HTTPS check after
a successful server-side deploy triggers the same rollback from the workflow.

**Who may roll back (the script tells the callers apart by `SUDO_USER` / `SUDO_UID`, which sudo itself sets):**

| Caller | Allowed |
|---|---|
| **Administrator** (root, or any sudoer other than the CI user) running `sudo /usr/local/sbin/cartoona-deploy rollback` on the server | Always: the unrestricted emergency rollback. No GO, no `--sha`, no time limit. |
| **CI identity** (`cartoona-deploy` over SSH; `Actions → Deploy → rollback` and the automatic rollback after a failed public check) | Only `rollback --sha <40 hex>` for the release **CI itself deployed most recently**, under a GO approval (`deployed_by=ci` and an `approval_id` in the state file), **within 60 minutes**, and **once** (a second CI rollback is refused). Anything else is refused with "ask an administrator". |

sudoers backs this up: the CI user may run `status`, `preflight *`, `deploy *` and
`rollback --sha *`, and nothing else, so a bare `rollback` cannot even reach the
script. After a rollback the state file is marked `rolled_back=1`.

**Never rolled back:** PostgreSQL data, schema, volume or credentials;
`.env.docker`; Nginx/Cloudflare. An image rollback **cannot** undo a database
migration. That is why deployment refuses whenever the database's applied
migrations differ from the commit's, and why migrations are never automatic.

### Schema changes (separate, manual, approved policy required)

There is no approved production migration policy yet; until there is, a commit
that adds a migration **cannot deploy** (refused at gate 6). When one is approved:

1. Back up first (docs/PRODUCTION_CUTOVER.md section 12; a restore drill must have passed).
2. Write migrations expand-only (additive) so the *previous* image keeps working
   on the new schema; destructive changes go in a later release.
3. Apply with the reviewed runner as an operator, write freeze ON:
   `PSQL=scripts/db/psql-docker.sh DATABASE_URL=postgresql://cartoona@postgres:5432/cartoona scripts/db/migrate-local.sh`
   from a checkout of the exact commit on the server.
4. Then deploy the commit (the migration list now matches).
5. Recovery from a bad migration is **restore from backup** (or a forward fix
   migration), never an image rollback.

## 6. Secrets and variables

### GitHub Actions (repository or `production` environment)

| Name | Kind | Value | Why |
|---|---|---|---|
| `DEPLOY_HOST` | secret | `<SERVER_IP>` | SSH target |
| `DEPLOY_USER` | secret | `cartoona-deploy` | never `root` (the workflow refuses it) |
| `DEPLOY_SSH_KEY` | secret | private half of the dedicated ed25519 deploy key | |
| `DEPLOY_KNOWN_HOSTS` | secret | verified `known_hosts` line(s) for the host (section 7.5) | strict host key checking |
| `DEPLOY_BRANCH` | variable | the one branch allowed to deploy | gate 2 |
| `CARTOONA_DEPLOY_MODE` | variable | `off` → `preflight` → `deploy` | gate 3 |
| `PUBLIC_HEALTH_URL` | variable | `https://cartoona.art/api/health` | optional public check |
| `DEPLOY_PORT` | variable | SSH port if not 22 | optional |
| `GHCR_PULL_AUTH` | variable | `job-token` (default) or `server` | section 7.7 |
| `NEXT_PUBLIC_SUPABASE_URL` | variable | must equal the server's `.env.docker` | public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | variable | must equal the server's `.env.docker` | public by design |
| `NEXT_PUBLIC_SITE_URL` | variable | `https://cartoona.art` (must equal the server's) | public by design |

`GITHUB_TOKEN` is automatic: `contents: read` everywhere, `packages: write` only in
the `images` job, `packages: read` in the deploy job.

### Server only (never in GitHub, never in an image, never in a log)

Everything in `/opt/cartoona/.env.docker`: `POSTGRES_PASSWORD`,
`CARTOONA_APP_DB_PASSWORD`, `BACKEND_DATABASE_URL`, `CARTOONA_INTERNAL_AUTH_SECRET`,
`SUPABASE_SECRET_KEY`, `RATE_LIMIT_HASH_SECRET`, `CARTOONA_WRITE_FREEZE`, … The
pipeline only ever *reads* this file on the server, prints no value from it, and
never writes it. The GO record (`/etc/cartoona/deploy-go`) and deployment state
(`/var/lib/cartoona-deploy/`) are server-only too.

## 7. Server setup (operator)

Run as root over the **existing** root access (not changed by any step here).
Steps 7.1–7.6 change nothing for the running application.

### 7.1 Prerequisites

```bash
docker compose version          # needs >= 2.24 (overlay uses !reset / !override)
command -v curl flock sha256sum # util-linux, coreutils, curl
uname -m                        # x86_64
grep -RnE 'proxy_pass' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
```

The `proxy_pass` must target `127.0.0.1:3000` (or `localhost:3000`) before 7.8
binds the frontend to loopback. Prefer `http://127.0.0.1:3000`: `localhost` can
resolve to `::1` first, which the loopback IPv4 binding does not serve.

### 7.2 Deploy user (no password, no docker group)

```bash
adduser --system --group --shell /bin/bash --home /home/cartoona-deploy cartoona-deploy
passwd -l cartoona-deploy
id cartoona-deploy              # must NOT list the docker group
```

### 7.3 SSH key (generate on the operator workstation, not the server)

```bash
ssh-keygen -t ed25519 -N '' -C cartoona-github-actions -f ./cartoona_deploy_ed25519
```

The private file becomes `DEPLOY_SSH_KEY` (section 8), then shred it locally
(`rm -P` on macOS, `shred -u` on Linux). On the server, with the **public** key:

```bash
install -d -m 0755 -o root -g root /home/cartoona-deploy/.ssh
printf 'restrict,command="/usr/local/sbin/cartoona-deploy-ssh" %s\n' \
  'ssh-ed25519 AAAA...paste-public-key... cartoona-github-actions' \
  > /home/cartoona-deploy/.ssh/authorized_keys
chown root:root /home/cartoona-deploy/.ssh/authorized_keys
chmod 0644 /home/cartoona-deploy/.ssh/authorized_keys
```

Root owns the key file, so the deploy identity cannot change its own restrictions.
`restrict` disables port/agent/X11 forwarding and PTYs. The forced command means
the key can do nothing but call `cartoona-deploy`.

Per-user SSH hardening (does not affect root or anyone else):

```bash
cat > /etc/ssh/sshd_config.d/60-cartoona-deploy.conf <<'EOF'
Match User cartoona-deploy
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
EOF
sshd -t && systemctl reload ssh
sshd -T | grep -iE '^(allowusers|allowgroups)'   # if set, add cartoona-deploy there
```

### 7.4 Install the server scripts (reviewed copies, root-owned)

From a checkout of the reviewed commit on the workstation:

```bash
sha256sum deploy/server/cartoona-deploy deploy/server/cartoona-deploy-ssh \
          deploy/server/sudoers.cartoona-deploy deploy/compose.production.yml
scp deploy/server/cartoona-deploy deploy/server/cartoona-deploy-ssh \
    deploy/server/sudoers.cartoona-deploy deploy/compose.production.yml \
    root@<SERVER_IP>:/root/cartoona-deploy-install/
```

On the server:

```bash
cd /root/cartoona-deploy-install && sha256sum *          # must match the workstation
install -o root -g root -m 0755 cartoona-deploy     /usr/local/sbin/cartoona-deploy
install -o root -g root -m 0755 cartoona-deploy-ssh /usr/local/sbin/cartoona-deploy-ssh
visudo -cf sudoers.cartoona-deploy && install -o root -g root -m 0440 sudoers.cartoona-deploy /etc/sudoers.d/cartoona-deploy
visudo -c
sudo -l -U cartoona-deploy   # exactly: (root) NOPASSWD: /usr/local/sbin/cartoona-deploy
```

**What is granted, and why:** `cartoona-deploy` may run one root-owned program
with sudo, and only these subcommands: `status`, `preflight *`, `deploy *` and
`rollback --sha *` (`/etc/sudoers.d/cartoona-deploy`). That program is root-equivalent *only for what it does*: pull images
from the two named GHCR repositories by digest and recreate the frontend/backend
services from root-owned compose files. The user is **not** in the `docker` group
(that would be unrestricted root). It cannot pass compose files, environment,
volumes, images from elsewhere, or shell commands. CI never updates the installed
scripts; an operator re-runs 7.4 after reviewing a change to them.

### 7.5 Verify the host key out-of-band

On the server through a channel you already trust (provider web console, or the
existing root session whose host key you verified before):

```bash
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
```

On the workstation:

```bash
ssh-keyscan -t ed25519,ecdsa,rsa <SERVER_IP> 2>/dev/null > cartoona_known_hosts
ssh-keygen -lf cartoona_known_hosts
```

Every `SHA256:` fingerprint must match the server's own output **exactly**. Only
then does the content of `cartoona_known_hosts` become `DEPLOY_KNOWN_HOSTS`. The
workflow uses `StrictHostKeyChecking yes` with only that file. If the host key
ever changes, the workflow fails closed until the secret is re-verified and updated.

### 7.6 Test the identity (no change to the application)

```bash
ssh -i ./cartoona_deploy_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=./cartoona_known_hosts cartoona-deploy@<SERVER_IP> status
ssh ... cartoona-deploy@<SERVER_IP> 'id; ls /'   # must be refused ("unknown flag"/usage), never run
```

Expect `status` to print key=value lines. Before 7.8 it reports what is missing
(for example the overlay file).

### 7.7 GHCR pull access

Default (`GHCR_PULL_AUTH=job-token`): each deploy job hands its own short-lived
`GITHUB_TOKEN` (`packages: read`, expires when the job ends) to the script on
stdin. No registry credential lives on the server. This needs the packages to
grant this repository access (section 8.3).

Fallback (`GHCR_PULL_AUTH=server`): store a **read-only** credential for root,
for example a classic PAT with only `read:packages`:
`docker login ghcr.io -u <github-user> --password-stdin` (as root, so it is kept
in `/root/.docker/config.json`, mode 0600). Rotate it on a schedule.

### 7.8 Adopt the running deployment (one-time; brief restart of frontend + backend)

This is the only step that changes running containers, and it is done by the
operator, not CI. Do it in a quiet window, write freeze ON (it is today).

```bash
cd /opt/cartoona
dc0() { docker compose --env-file .env.docker "$@"; }                    # how it runs today
dcp() { docker compose --project-directory /opt/cartoona --env-file .env.docker \
          -f compose.yml -f compose.production.yml "$@"; }               # how it runs from now on

# 1. Record the current state.
dc0 ps
docker inspect --format '{{.Name}} {{.Image}}' $(dc0 ps -q)

# 2. compose.yml must be byte-identical to the commit you will deploy.
sha256sum compose.yml        # compare with: git show <commit>:compose.yml | sha256sum
#    If it differs, see 7.10 (read-only comparison first; never git reset/pull).

# 3. The running images become the first 'deployed' baseline (and rollback target).
docker tag "$(docker inspect --format '{{.Image}}' "$(dc0 ps -q frontend)")" cartoona-frontend:deployed
docker tag "$(docker inspect --format '{{.Image}}' "$(dc0 ps -q backend)")"  cartoona-backend:deployed

# 4. Overlay and file modes.
install -o root -g root -m 0644 /root/cartoona-deploy-install/compose.production.yml compose.production.yml
chmod 0644 compose.yml
chmod 0600 .env.docker   # or 0640 with an admin group; never readable by others (the script refuses)

# 5. Apply: same images, frontend now on 127.0.0.1:3000. PostgreSQL is not touched.
dcp up -d --no-deps --no-build --pull never --wait backend frontend

# 6. Verify.
ss -ltnp | grep -E ':(3000|4000|5433)\b'      # every one on 127.0.0.1
/usr/local/sbin/cartoona-deploy status          # all health.* = pass, write_freeze on
curl -fsS https://cartoona.art/api/health
```

From now on, manual compose commands on the server **must** include both files
(`dcp`). Plain `docker compose --env-file .env.docker up` would bring back the
old local image tag and publish port 3000 on all interfaces.

### 7.9 GO record (one approval = one exact release, once)

Only after the GO decision exists in writing, and only for a release whose
**dry run (`preflight`) you have reviewed**: the job summary shows the commit SHA
and both image digests. The approval names exactly those three values.

```bash
install -d -m 0755 -o root -g root /etc/cartoona
cat > /etc/cartoona/deploy-go <<'EOF'
decision=GO
approval_id=<unique, 8-64 characters of A-Za-z0-9._- , e.g. go-20261201-1>
approved_by=<approver name>
approved_at=<UTC now, e.g. 2026-12-01T09:00:00Z>
expires_at=<UTC, at most 72 h after approved_at, e.g. 2026-12-01T21:00:00Z>
reference=<link to the written GO decision>
release_sha=<40-hex commit from the preflight summary>
frontend_digest=sha256:<64 hex from the preflight summary>
backend_digest=sha256:<64 hex from the preflight summary>
EOF
chown root:root /etc/cartoona/deploy-go && chmod 0644 /etc/cartoona/deploy-go
```

Rules enforced by the script (not by convention):
* Every field appears exactly once; the commit **and both digests** must equal
  the release being deployed; it must be unexpired and at most 72 h long.
* **Single use:** the approval is spent when the deploy passes its checks and
  starts, before any container or tag changes, and stays spent if the deploy
  fails and is rolled back. Re-running needs a **new** approval (new
  `approval_id`). Two simultaneous deploys with one approval: exactly one wins.
* The write freeze is not configurable here. `expect_write_freeze` is obsolete
  and makes the record invalid: CI never deploys with `CARTOONA_WRITE_FREEZE`
  off. Lifting the freeze (cutover Phase 6.1) is an operator action.

Consequence: with `CARTOONA_DEPLOY_MODE=deploy`, a new push is refused until you
have approved *that* release: push → CI + dry-run summary → you write the GO →
re-run the deploy job (`Re-run jobs`, or `Actions → Deploy` with the digests).

**Revoke instantly:** `rm /etc/cartoona/deploy-go`. **Check state:**
`sudo /usr/local/sbin/cartoona-deploy status` (`go.present`, `go.expires_at`,
`go.consumed`).

### 7.10 Reconciling the server's locally modified `compose.yml` (later, by an operator)

The server's `/opt/cartoona/compose.yml` was edited by hand to bind the frontend
to `127.0.0.1`. The repository's `compose.yml` now binds **every** published port
to loopback itself (and the overlay still forces it), so the edit is expected to
be redundant. The pipeline refuses to deploy while the server file differs from
the commit's (gate 6), which is intended. Reconcile **once**, deliberately; the
pipeline never does this and never runs `git` on the server (no reset, no pull,
no checkout, no overwrite):

```bash
cd /opt/cartoona
# 1. Read-only: what is different?
git -c safe.directory=/opt/cartoona status --short compose.yml
git -c safe.directory=/opt/cartoona diff -- compose.yml        # local edit vs. the checked-out commit
# 2. Compare with the commit you intend to deploy (fetch it ELSEWHERE, e.g. your workstation):
sha256sum compose.yml                                          # server
git show <commit>:compose.yml | sha256sum                      # workstation
# 3a. Identical hashes: nothing to do.
# 3b. Different: review every changed line. Anything that is not already in the
#     repository must be committed there first, through review.
# 4. Only then install the reviewed file, keeping the old one:
cp -p compose.yml "/root/compose.yml.local-edit-$(date -u +%Y%m%dT%H%M%SZ)"
install -o root -g root -m 0644 /root/reviewed/compose.yml /opt/cartoona/compose.yml
sha256sum compose.yml                                          # must equal the commit's
```

Until step 4 the dry run reports `server compose.yml differs from the commit's
compose.yml`. After it, and after 7.8, the dry run's `check.ports_config=pass`
confirms the effective configuration is loopback-only, and `health.ports_loopback=pass`
confirms the running containers are.

## 8. GitHub setup (admin)

### 8.1 Secrets and variables

`Settings → Secrets and variables → Actions`: create the secrets and variables in
section 6. Prefer the `production` **environment** for the four `DEPLOY_*`
secrets when the plan supports environment secrets: then only the deploy job can
read them. Otherwise use repository secrets; `ci.yml` passes exactly those four
to the deploy workflow.

### 8.2 Environment `production`

`Settings → Environments → New environment → production`:
* Deployment branches: *Selected branches* → only `DEPLOY_BRANCH`.
* Required reviewers: add the approver(s) if available. Each deployment then
  waits for a click.

If the plan does not offer these protection rules (private repositories on some
plans), the environment still records deployments but gates nothing. The gates
that hold regardless are the variables (admin-only) and the server GO record.

### 8.3 GHCR packages

The first push to an integration branch creates both packages. Then, for **each**
package (`Your profile → Packages → cartoona-frontend / cartoona-backend →
Package settings`):
* Visibility: **private**.
* *Manage Actions access*: this repository with **Write** (CI pushes and the
  deploy job reads).
* Do not add other repositories or users.

### 8.4 Branch protection for `DEPLOY_BRANCH`

Whoever can push to `DEPLOY_BRANCH` can, once deployment is enabled, ship code to
production. Protect it: require a pull request, require the `CI` checks
(`Validate…`, `Tests…`, `Images…`), disallow force-push and deletion.

## 9. Activation procedure

**A–F** are sections 7.1–7.7 and 8. Then:

**G. Safe dry run.** Set `DEPLOY_BRANCH` and `CARTOONA_DEPLOY_MODE=preflight`.
Push a commit to that branch. Expect: CI green, images published, the deploy job
showing `result=preflight_ok`, every `check.*` and `health.*` = pass,
`go.valid_for_release=no`. Nothing on the server changed (verify the container start times:
`docker ps --format '{{.Names}} {{.Status}}'`). Any `refused` names what to fix.

**H. First authorized deployment.** Only after the GO decision is recorded in
writing, and after reconciling the server's compose file (7.10) and adopting the
running stack (7.8): take the commit SHA and both digests from the dry run's
summary, write the single-use GO for exactly those (7.9), set
`CARTOONA_DEPLOY_MODE=deploy`, and re-run the deploy job. Watch the job summary
(`go.consumed=yes`, probes, `health.ports_loopback=pass`). Verify the site manually.
A second run with the same approval is refused by design.

**I. Rollback verification.** Right after H, within 60 minutes, run
`Actions → Deploy → rollback` with the same `release_sha` (CI may undo only the
release it just deployed), or `sudo /usr/local/sbin/cartoona-deploy rollback` as
an administrator (always allowed). Expect `result=rolled_back` and all probes
pass on the previous images. Rolling forward again needs a **new** approval.
Record both results.

To pause everything: `CARTOONA_DEPLOY_MODE=off` (GitHub) and/or
`rm /etc/cartoona/deploy-go` (server).

## 10. Server configuration review (phase 7)

Read-only checks for the operator. None prints a secret value.

```bash
cd /opt/cartoona
grep -c '^CARTOONA_WRITE_FREEZE=1$' .env.docker              # 1
stat -c '%U:%G %a' .env.docker                                # root:root 600
grep -oE '^[A-Z_]+' .env.docker | sort | uniq -d              # no duplicates
grep -E '^(DEV_PARENT_AUTH_ENABLED|DEV_PARENT_AUTH_SECRET|RATE_LIMIT_DISABLED|CARTOONA_ALLOW_DESTRUCTIVE_TESTS|CARTOONA_PAYMENT_PROVIDER)=.' .env.docker | cut -d= -f1   # nothing
ss -ltnp | grep -E ':(3000|4000|5433)\b'                       # 127.0.0.1 only (after 7.8)
ufw status verbose
curl -fsS http://127.0.0.1:4000/ready; curl -fsS http://127.0.0.1:3000/api/health
```

For the full configuration check, run the existing preflight (it reads
`process.env`) inside each running container, from a checkout of the deployed
commit. The images do not ship the ops scripts, so copy them into the container's
ephemeral `/tmp` first (`dcp` as in 7.8):

```bash
for svc in frontend backend; do
  dcp cp scripts/ops/production-preflight.mjs      "$svc:/tmp/production-preflight.mjs"
  dcp cp scripts/ops/production-preflight-core.mjs "$svc:/tmp/production-preflight-core.mjs"
done
dcp exec -T frontend node /tmp/production-preflight.mjs --service frontend --expect-freeze on
# The freeze lives in the frontend only; the backend reaches PostgreSQL over the
# private compose network (no TLS), which the flag acknowledges explicitly.
dcp exec -T backend node /tmp/production-preflight.mjs --service backend --allow-plaintext-private-db
```

Expect `OK` for both (warnings allowed). See docs/PRODUCTION_CUTOVER.md section 10.

Checks the operator should make on the server before activating (a past audit
found items here that must be confirmed fixed; details are kept out of the repository):
* `CARTOONA_WRITE_FREEZE=1` must be present exactly once in `.env.docker`. Every
  deploy and preflight refuses otherwise; CI never sets it.
* `CARTOONA_APP_ORIGIN` must be set deliberately to the public https origin;
  otherwise compose defaults to `http://localhost:3000` and the CSRF guard refuses
  browser writes.
* The base `compose.yml` publishes the frontend on all interfaces. **Docker-published
  ports bypass UFW** unless the `DOCKER-USER` chain filters them, so a UFW deny
  rule for 3000 may not apply. Check from outside the server:
  `curl -m5 http://<SERVER_IP>:3000/api/health`. The overlay (7.8) binds it to loopback.
* Nginx must proxy to `http://127.0.0.1:3000` (7.1).
* `.env.docker` should be `root:root 0600`; Compose >= 2.24 is required.
* Backend (`127.0.0.1:4000`) and PostgreSQL (`127.0.0.1:5433`) are already
  loopback-only.
* The frontend container receives `.env.docker` with every database variable
  blanked by `compose.yml`; the smoke test verifies this.
* Health bodies are fixed literals (`{"status":"ok"}`, `{"status":"ready"}`,
  `{"status":"unavailable"}`): no versions, errors, hosts or env values.
* No workflow uploads artifacts; logs contain names, digests and pass/fail only.

## 11. Troubleshooting

| Symptom | Meaning / action |
|---|---|
| deploy job skipped | Not a push to `DEPLOY_BRANCH`, or `CARTOONA_DEPLOY_MODE` not set. Expected when off. |
| `SSH connection failed` (255) | Host key mismatch (re-verify 7.5; **do not** disable checking), wrong key, firewall. |
| `refused … compose.yml differs` | The server's compose files are not the commit's. Review and install (7.8 step 2), or commit the server's intended change. |
| `refused … database migrations differ` | The commit adds or lacks a migration relative to the database. No automatic migration: section 5, "Schema changes". |
| `refused … CARTOONA_WRITE_FREEZE` | The freeze is not exactly `1` once in `.env.docker`. CI never deploys with it off and never changes it. Fix on the server. |
| `refused … Compose would publish beyond loopback: <svc>:<port>` / `health.ports_exposed` | A published port is not loopback-only in the effective config, or a running container is bound to a public address (typically before 7.8). Fix the compose files or recreate the container; never open ports 3000, 4000 or 5433. |
| `refused … not owned by root` / `group/world-writable` / `…protected` | A deployment file or directory (`/opt/cartoona`, compose files, `.env.docker`, `/etc/cartoona`, the GO record) has the wrong owner or mode. |
| `refused … NEXT_PUBLIC_*` | The repository variables differ from the server's `.env.docker`. Fix the variables, push again (new images). |
| `refused … CURRENT deployment is not healthy` | The release to fall back to is broken. Fix manually first (`status` shows which probe fails). |
| `refused … could not pull` | GHCR access (8.3), or `GHCR_PULL_AUTH`. |
| `refused … no GO record` / `…different commit` / `…different … digest` / `…expired` / `…already used` | The GO approval is missing, belongs to another release, has expired (max 72 h) or was spent. Write a new one for this exact release (7.9). `preflight` shows the reason (`go.reason`). |
| `refused … ask an administrator` (rollback) | CI may only undo the release it deployed most recently, once, within 60 minutes. Roll back on the server as an administrator. |
| exit 3 `failed_rolled_back` | New release unhealthy; previous images restored and verified. See `docker compose … logs backend frontend`. |
| exit 4 `failed_rollback_failed` | Both failed. Operator now: `status`, logs; restore manually with `dcp` and the `:rollback` tags. |
| test baseline failed with many skips | The PostgreSQL service did not start or `CARTOONA_PLAIN_PG` was lost. Never "fix" by lowering the baseline. |

Server logs: `/var/lib/cartoona-deploy/history.log` (one line per deploy/rollback),
`current.env`, `previous.env`. Old images accumulate. Prune deliberately
(`docker image ls`, `docker image rm <id>`). **Never** `docker system prune --volumes`
or `docker compose down -v`.

## 12. Security model

* **No secret leaves the server.** CI has no database, Supabase or application
  secrets. Its four deploy secrets let it do exactly what `cartoona-deploy` allows.
* **Server-side enforcement.** A modified workflow on the deploy branch cannot
  skip the hard rules: freeze (always ON), migrations, compose identity,
  loopback-only ports, image origin, the single-use GO approval bound to the exact
  commit and image digests, and rollback authorization all live in the root-owned
  script, which CI cannot change. The workflow cannot even claim a different commit
  for the approved digests, because the digests themselves are in the approval.
* **Least privilege.** Not in the `docker` group; one sudo entry limited to four
  subcommands (`status`, `preflight`, `deploy`, `rollback --sha`); a forced SSH
  command that refuses empty and multi-line input and never evaluates it;
  `restrict`; no TTY; root-owned `authorized_keys`; the script's state, lock and
  approval-consumption markers in a root-only directory; ownership and permission
  checks on every deployment file; `GITHUB_TOKEN` scoped per job; third-party
  actions pinned to commit SHAs. The script never runs `git`.
* **Emergency path.** Administrators keep an unrestricted rollback through their
  own `sudo`; the CI key cannot use it.
* **Strict host keys.** Verified out-of-band; `StrictHostKeyChecking yes`;
  `UpdateHostKeys no`; never `StrictHostKeyChecking=no`.
* **Residual risks.** (1) Anyone who can merge to `DEPLOY_BRANCH` can run code in
  the app containers once deployment is enabled (branch protection, 8.4).
  (2) The SSH private key and the job token exist on GitHub-hosted runners for the
  duration of a job. (3) The script runs `docker` as root by design. Review every
  change to `deploy/server/*` as a privileged change.
* **Optional notifications (no paid service).** GitHub already emails the actor
  on a failed run. *Watch → Custom → Actions*, or a GitHub mobile push, is enough.

## 13. Known limitations

* Nothing in this document has been run against the real server or GitHub yet.
  Verified locally: the workflows (actionlint), scripts (shellcheck), the full
  test suite, both image builds, image hygiene, the smoke stack, and the server
  script in a Linux rehearsal with a stand-in registry (deploy, every refusal,
  automatic and manual rollback). The approval and rollback-authorization rules,
  ownership checks, port-exposure detection, read-only inspection, the sudoers
  file (`visudo` and `sudo -l` matching) and the forced-command parsing were
  rehearsed the same way; the rehearsal harness is not part of the repository,
  while `tests/unit/deploy-hardening-static.test.ts` pins the same rules.
* Manual `workflow_dispatch` runs appear only once `deploy.yml` is on `main`.
* Test files have pre-existing type errors (section 2).
* Zero-downtime is not a goal: frontend and backend restart in turn (seconds) on
  a single host.
* No production migration policy, backups or alerting exist yet
  (docs/PRODUCTION_CUTOVER.md section 15). These remain cutover blockers and are
  outside CI/CD.
