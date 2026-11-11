# Solar Monitoring Platforms — API Access Request Procedures

> Reference guide for obtaining developer / OpenAPI access across the solar monitoring
> providers integrated into the TSBA AI Agent platform.
>
> **Prepared:** 2026-11-06

---

## Overview

Each solar monitoring provider gates API / developer access differently. Some can be
self-activated from the owner/administrator portal; others require a support request
from the registered account email. This document lists the exact activation path for
each provider.

| # | Platform | Access method | Who can action it |
|---|----------|---------------|-------------------|
| 1 | SolisCloud | Self-service (portal) | Owner / Administrator account |
| 2 | Elekeeper (SAJ) | Self-service (Open Platform) | Account owner |
| 3 | WHEC Echo-Hub | Support request | Registered email |
| 4 | Solarman | Support request | Registered email |

---

## 1. SolisCloud

**Access type:** Self-service via the owner or administrator account.

**Requirements:**
- Must be logged in with an **Owner** or **Administrator** account (standard users cannot enable this).

**Steps:**
1. Log in to the SolisCloud portal with the owner/administrator account.
2. Open the **left-hand menu**.
3. Go to **Services → API Management**.
4. Click **Activate**.
5. Complete the activation process as prompted.

**Result:** API credentials (Key ID / Key Secret) are issued and API management becomes available for the account.

---

## 2. Elekeeper (SAJ)

**Access type:** Self-service via the **Open Platform** (developer portal).

**Steps:**
1. Log in to the Elekeeper portal.
2. In the **top-right toolbar**, click the **apps / grid icon** (⊞) to open the application menu.
3. Select **Open Platform** from the dropdown.
   - *(The same menu also contains Display Management, Version Information, FAQ, Feedback, Operating Manual, Agreement Policy, and About Us.)*
4. On the **Developer Platform** page, choose how to proceed:
   - **Autonomous Account** → click **Create Developer Organization**
     *(use this to become a developer and obtain your own development resources — API keys, etc.)*
   - **Third-Party Account** → **Select third-party developers**
     *(use this only to authorize resources to an existing third-party developer.)*
5. For first-party API access, click **Create Developer Organization** and complete the organization setup to obtain development resources.

**Result:** The account becomes a developer organization with access to development resources (API credentials).

---

## 3. WHEC Echo-Hub

**Access type:** Support request (manual enablement).

**Steps:**
1. From the **registered account email address**, compose an inquiry to the WHEC Echo-Hub **support team**.
2. Request that **OpenAPI access be enabled** on the account.
3. Send the request **from the registered email** so the support team can verify account ownership.

**Notes:**
- Sending from the registered email is required for identity verification.
- Include the account name/ID and the intended use case to speed up approval.

**Result:** Support enables OpenAPI access on the account; credentials/instructions are returned by the support team.

---

## 4. Solarman

**Access type:** Support request (manual enablement).

**Steps:**
1. Contact the Solarman **support team** from the **registered account email**.
2. Request activation of the **Developer option / OpenAPI access** for the account.

**Notes:**
- Include the registered account details and intended integration scope.
- Send from the registered email for verification.

**Result:** Support activates the developer/OpenAPI option; API credentials are issued for integration.

---

## Summary of Action Items

- [ ] **SolisCloud** — Activate API Management from owner/admin portal (Services → API Management → Activate).
- [ ] **Elekeeper (SAJ)** — Open Platform → Create Developer Organization.
- [ ] **WHEC Echo-Hub** — Email support from registered address to enable OpenAPI.
- [ ] **Solarman** — Email support from registered address to activate Developer/OpenAPI.
