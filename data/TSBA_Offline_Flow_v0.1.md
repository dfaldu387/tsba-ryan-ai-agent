# "My system is offline": support flow v0.1 (draft)

Status: draft for the TSBA assistant and the later voice assistant. Built from the SOFAR SAR-100 user manual sent by Dhaval on 20 Oct 2026. Deye, SAJ and the SOFAR Wi-Fi stick are placeholders until their guides arrive. Items marked [CONFIRM] need Dhaval's answer before customers see them.

---

## 1. Safety rules for this flow (never break)

1. Never tell a customer to press or hold the Reset button. On the SAR-100, holding Reset for 4 seconds restores factory settings, including the export (feed-in) limit settings (manual 8.4, p. 34; 7.2, p. 19).
2. Never tell a customer to change export, feed-in, CT, meter or inverter settings. The same web page that sets the Wi-Fi also holds these settings (manual 7.3, pp. 21-22).
3. Never ask a customer to open the SAR-100 enclosure, the switchboard or the inverter, or to look at internal lights. The logger and its lights sit inside the box (manual 6.3, p. 10). Electrical work must be done by a licensed electrician.
4. If the logger login has been changed, or anything unexpected appears, stop and hand over to the TSBA team.
5. Never ask for or repeat the customer's Wi-Fi password in chat logs shared with others.

---

## 2. Decision tree

**Step 1. Confirm what "offline" means**
- Ask: does the app say "offline", or does it just show no power being produced? Since when?
- Ask: is the inverter screen or light on?
- If the inverter looks off or the power was cut: hand over to the team (possible tripped breaker or fault; electrical, not a Wi-Fi problem).
- If only the app shows no data, go to Step 2.

**Step 2. Identify the brand and hardware**
- Ask which brand: SOFAR, Deye, SAJ or other. If unsure, ask for a photo of the inverter label or the app name.
- SOFAR with an SAR-100 export-limit box: go to Section 3.
- SOFAR with a Wi-Fi stick only: [PENDING GUIDE] hand over to the team for now.
- Deye: [PENDING GUIDE] hand over to the team for now.
- SAJ: [PENDING GUIDE] hand over to the team for now.
- Other brands: hand over to the team.

**Step 3. Check what changed (common causes)**
- New modem or router (e.g. NBN change)?
- Changed Wi-Fi name or password?
- Internet down at the house?
- Router moved further away?
- Router set to 5 GHz only? The SAR-100 supports 2.4 GHz only (manual p. 24).
- Wi-Fi name or password contains ; , = or "? Not supported (manual p. 24).

**Step 4. Guide the reconnection** (brand-specific steps, Section 3 for SAR-100)

**Step 5. Confirm or hand over**
- Ask the customer to check the app again after about 10 minutes.
- If still offline, or any step failed: hand over with the summary in Section 5.

---

## 3. SOFAR SAR-100: customer-safe reconnect steps

Use when a SOFAR customer has an SAR-100 export-limit box and the house Wi-Fi changed. Source: SOFAR SAR-100 User Manual, sections 7.1 and 7.3 (pp. 17-27).

Before you start:
- Use a phone or laptop, standing near the SAR-100 box.
- Have the home Wi-Fi name and password ready. The Wi-Fi must be 2.4 GHz.

Steps:
1. On your phone, open Wi-Fi settings and connect to the network that starts with **AP_** followed by a serial number. This is the box's own Wi-Fi.
2. Open a web browser and go to **10.10.100.254**.
3. Log in with username **admin** and password **admin**. [CONFIRM: installers may have changed this. If it doesn't work, stop and contact TSBA.]
4. If a message asks whether to encrypt the access point, choose **Cancel**. [CONFIRM: is this the right choice for TSBA customers?]
5. Open the network settings and choose **Wireless connection**. [CONFIRM: the manual's Wizard goes through export-limit settings first. Customers must not change anything on those pages. Dhaval to confirm the safest path to reach only the Wi-Fi step.]
6. Select your home Wi-Fi network and enter its password.
7. Leave "Automatically obtain IP address" set to **Enable** and click **Next**.
8. Click **OK** and wait for the box to restart.
9. Reconnect your phone to your home Wi-Fi. Check the SOLARMAN app after about 10 minutes.

If something doesn't match these steps, or the system is still offline after 10 minutes, don't try anything else. Contact TSBA and we'll take it from there.

Installer-only notes (never send to customers):
- Weak Wi-Fi signal: an external antenna can be fitted to the logger, or the box can be connected to the router by Ethernet cable (manual pp. 15, 51).
- Offline on a network with a firewall: whitelist access1.solarmanpv.com, access2.solarmanpv.com and access3.solarmanpv.com on port 10000 (manual pp. 24, 51).
- Monitoring app: SOLARMAN Smart is recommended for household systems; SOLARMAN Business for installers and O&M (manual p. 35).

---

## 4. Placeholders (waiting on Dhaval)
- SOFAR Wi-Fi stick (no SAR-100): reconnect guide and app name.
- Deye data logger: reconnect guide and app name. Deye support shared Wi-Fi logger configuration PDFs in the support chat; ask Dhaval to forward them.
- SAJ: reconnect guide and app name.
- The 10 most common app questions customers ask, and where they usually get stuck.

---

## 5. Hand-over summary (what the team receives)
- Customer and site (from the ticket, not repeated in shared logs)
- Brand, hardware (SAR-100 / Wi-Fi stick / other) and app name
- When it went offline and what changed (router, password, power outage)
- Steps the customer completed and where it failed
- Inverter screen status (on / off / error shown)
- Photos sent (inverter label, error screen)

Customer message on hand-over:
"This is an automated response from TSBA Technical Support. Thanks for trying those steps. I've passed your system to our team with everything you've told me, so you won't need to repeat it. They'll be in touch shortly."

---

## 6. Questions for Dhaval
1. Do most SOFAR customers have an SAR-100, or a Wi-Fi stick on the inverter?
2. Have installers kept the default admin/admin login and the open AP_ network?
3. What's the safest way for a customer to reach only the Wi-Fi step without passing the export-limit pages?
4. Have customers ever reset the box by mistake?
5. Which app do customers use for each brand (SOLARMAN Smart for SOFAR?)
6. Where do customers usually get stuck?
7. Does TSBA have SOLARMAN Business access to see which sites are offline?
8. Deye and SAJ reconnect guides.
