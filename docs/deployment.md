# Deploy Little Table

Little Table runs as a Cloudflare Worker with Durable Objects, D1 and R2. The
[standalone stack](../alchemy.run.ts) configures its own WorkOS AuthKit accounts.
If your app already owns accounts and boards, use the [host integration](hosting.md).

## Standalone stack

[Install the pinned Bun and Node versions](development.md). Configure the
Cloudflare account, WorkOS application and signing key, then use the pinned
Alchemy CLI:

```sh
bun install
./node_modules/.bin/alchemy deploy --stage <stage> --yes
```

The stack applies the D1 migrations and creates the image bucket. Set
`TABLETOP_DOMAIN` to use a custom domain for `prod` and its `staging` subdomain.
Other stages use workers.dev. Add `https://<host>/auth/callback` and
`https://<host>/` as the WorkOS sign-in and sign-out redirect URLs for each
deployed host. The domain also needs a [tldraw licence](https://tldraw.dev/sdk-features/license-key).

## GitHub Environments

The [Deploy workflow](../.github/workflows/deploy.yml) deploys `prod` after
checks pass on `main`. For another stage, dispatch the workflow with that stage
name. The workflow uses `production` for `prod` and `staging` for manually
deployed non-production stages. It reports a skipped deploy if required
configuration is missing.

| Name                    | Kind     | Value                                                                                             |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Secret   | Cloudflare API token for the deployment account                                                   |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Deployment account ID                                                                             |
| `WORKOS_API_KEY`        | Secret   | WorkOS API key for the environment                                                                |
| `WORKOS_CLIENT_ID`      | Variable | WorkOS client ID for the environment                                                              |
| `TABLETOP_SIGNING_KEY`  | Secret   | RSA private key. Generate it with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`. |
| `TLDRAW_LICENSE_KEY`    | Variable | Public tldraw key for the deployment domain                                                       |

Use a separate WorkOS application for non-production deployments. Protect
`main` and restrict the `production` and `preview` Environments to that branch.

### Cloudflare permissions

Create a custom API token scoped to the deployment account. Allow editing
Workers Scripts, D1, R2 and Secrets Store. Alchemy uses the Secrets Store for
its state store. For a custom domain, also permit reading the zone and editing
Workers Routes and DNS in that zone. Cloudflare DNS must serve the zone in the
same account.

## Pull request previews

The [PR Preview workflow](../.github/workflows/pr-preview.yml) creates a preview
for same-repository PRs opened, updated, retargeted or reopened by a collaborator
with Write access. For a fork, a maintainer with Maintain or Admin access can
dispatch **PR Preview** from `main` with the PR number and reviewed head SHA.

Configure the `preview` Environment with the Cloudflare and non-production
WorkOS values above. Previews generate their own signing keys and use workers.dev,
so the Cloudflare token can omit zone permissions. Set the repository variable
`PREVIEW_TLDRAW_LICENSE_KEY` to a tldraw key valid on the account's workers.dev
subdomain. Configure WorkOS redirect URLs for the preview hosts.
Use only non-production WorkOS data because preview code can access the WorkOS
application configured for it.

A preview gets its own Worker, Durable Objects, database and bucket. The workflow
posts its link on the PR and removes the stage when the PR closes. Each open PR
uses one Worker and one D1 database from the account's limits.
