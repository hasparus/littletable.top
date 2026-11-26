# Community marketplace

Each JSON file in this directory lists one reviewed Gizmo. Its filename identifies the source repository and manifest path. Its URL pins the exact reviewed commit. Little Table builds the shared-board marketplace from these entries and the official listings in [registry.json](../registry.json).

Players and owners can submit a Gizmo from the marketplace. Choose **Public marketplace** and paste a public GitHub folder or manifest URL. Little Table resolves it to a commit. A configured deployment sends a pull request proposal to the repository workflow. Other deployments give the submitter a prepared GitHub issue to confirm. The issue starts the same workflow once it exists on the repository’s default branch.

## Reviewing a submission

Open the linked source directory at the proposed commit. Inspect the entry points, dependencies, requested permissions, network access, data handling and artwork licensing. For an update, compare the proposed commit to the previously accepted one. A commit pin fixes the Git source. Review any mutable resources the Gizmo loads separately.

The proposal contains registry metadata only. Review the displayed name and provide a small local thumbnail if the default Little Table icon is insufficient. Merge the PR to accept the revision into the next deployment. Close it without merging to block that revision from the marketplace. A repeated submission links back to the same review. A different commit gets its own review. Board owners continue to control their independent installs from links.

## Deployment

The workflow runs on the default branch of `hasparus/littletable.top`. Enable GitHub Actions to create pull requests in the repository settings. Direct in-app submission uses an optional `GIZMO_SUBMISSIONS_TOKEN` Worker secret with **Actions: write** on this repository to dispatch the workflow. The issue path needs GitHub Issues enabled and the submitter signed in to GitHub. Each workflow run uses its job token to write the proposal branch and open the PR. Require maintainer review in the branch rules protecting main.

GitHub documents the [default-branch requirement for dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) and [repository settings for Actions pull requests](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).
