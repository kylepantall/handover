# Signing the Windows build

The release workflow signs `handover.exe` with [Azure Artifact Signing](https://github.com/Azure/artifact-signing-action) (formerly Trusted Signing) when it is configured, and publishes unsigned otherwise. A signed exe is the most effective way to stop antivirus heuristics flagging it.

## One-time setup (needs an Azure subscription)

1. In Azure, create an **Artifact Signing account** and a **certificate profile** (Public Trust). Check eligibility first: identity validation is required.
2. Create an app registration with a **federated credential** for this repo (GitHub Actions, entity: tag, or `repo:kylepantall/handover:ref:refs/tags/*`).
3. Give that app the **Artifact Signing Certificate Profile Signer** role on the signing account.
4. In GitHub → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_CLIENT_ID` | App registration client ID |
| Secret | `AZURE_TENANT_ID` | Tenant ID |
| Secret | `AZURE_SUBSCRIPTION_ID` | Subscription ID |
| Variable | `ARTIFACT_SIGNING_ENDPOINT` | Regional endpoint, e.g. `https://eus.codesigning.azure.net/` (must match the account's region) |
| Variable | `ARTIFACT_SIGNING_ACCOUNT` | Signing account name |
| Variable | `ARTIFACT_SIGNING_PROFILE` | Certificate profile name |

The next `v*` tag is signed. The workflow fails the release if the signature isn't `Valid`, and runs the signed exe before packaging to prove signing didn't break it.
