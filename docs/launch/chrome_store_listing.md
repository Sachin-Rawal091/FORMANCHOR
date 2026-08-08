# FormAnchor — Chrome Web Store Listing Details

This document contains the official metadata, descriptions, and feature lists for the FormAnchor Chrome Web Store submission.

---

## 1. Extension Metadata

*   **Extension Name:** FormAnchor — Resilient Automated Form Filler
*   **Subtitle (Short Description - Max 132 chars):** Automatically fill complex, multi-page web forms from Excel. Shadow DOM piercing & smart CAPTCHA recovery.
*   **Category:** Productivity
*   **Supported Languages:** English (United States)
*   **Privacy Policy URL:** `https://github.com/Sachin-Rawal091/FORMANCHOR/blob/main/PRIVACY.md`
*   **Support URL:** `https://github.com/Sachin-Rawal091/FORMANCHOR/issues`

---

## 2. Detailed Description (Max 16,000 characters)

### The Smartest, Most Resilient Way to Automate High-Volume Data Entry

> **Single Purpose:** FormAnchor automates repetitive web form filling from spreadsheet data.

FormAnchor is a production-grade, privacy-first browser automation tool designed to eliminate repetitive, manual form filling at scale. Unlike simple auto-fill extensions that break on modern web architectures, FormAnchor is built with a resilient multi-layered automation engine that handles multi-page wizards, dynamic single-page applications (React, Vue, Angular), and real-world execution hiccups with full grace.

Whether you are filing tax documents, submitting government clearances, processing SaaS registrations, or uploading job application fields, FormAnchor turns spreadsheets into seamless, hands-free automation.

---

### How It Works (The 3-Step Flow)

1.  🔴 **Record Once:** Turn on the extension's high-fidelity recorder, navigate to your target form, and fill it out once. FormAnchor captures every click, select, input, radio toggle, checkbox click, rich-text frame, and datepicker in a high-fidelity automation flow.
2.  📊 **Upload Excel:** Drop your data spreadsheet. FormAnchor parses it instantly in-browser using robust SheetJS parsers, presenting a clean column-mapping screen with visual confidence badges.
3.  ▶️ **Fly on Autopilot:** Press Run. FormAnchor iterates through your rows, executing the recorded steps step-by-step, validating input formats, waiting dynamically for DOM stability, and writing detailed execution logs locally.

---

### Core Automation Engines (Built for Real-World Sites)

*   **8-Strategy Selector Fallback (with Shadow DOM Piercing):** If a web developer updates an input ID or relocates a field, FormAnchor's Selector Engine automatically falls back through 8 alternative matching strategies (including XPath, computed CSS path, ARIA labels, and Associated Text labels). It recursively traverses the Shadow DOM up to 500 elements deep to find and fill elements hidden from generic extensions.
*   **Smart Wait Engine (Dynamic DOM & Network Stability):** No more arbitrary sleep timers. FormAnchor dynamically checks for layout stability using a MutationObserver, listens for fetch/XHR network idle ceilings, and monitors URL changes with a dual-signal SPA parser (verifying that both the URL has shifted and a significant fraction of body children have updated).
*   **Smart Auto-Coercion & Variable Resolution:** FormAnchor automatically handles 8 distinct missing-value scenarios. It auto-coerces Excel cell values to match form schemas (e.g. converting `"true"` to a boolean, or date strings to native Date objects) and uses configurable defaults when columns are empty.
*   **Intelligent CAPTCHA Recovery Loop:** When a reCAPTCHA, hCaptcha, or Cloudflare challenge is encountered, FormAnchor pauses automation, rings a sound notification, badges the extension icon, alerts the user, and renders a floating glassmorphic overlay. The user solves the CAPTCHA manually, clicks Resume, and FormAnchor continues where it left off.
*   **Save & Continue Checkpoints:** If your browser crashes or a tab closes mid-run, your state is preserved. FormAnchor checkpoints execution progress after every step in volatile storage, letting you restore active sessions with zero data corruption.

---

### Privacy & Security First

*   **100% Client-Side:** All data parsing, script recording, and form execution happen strictly inside your browser. No external API servers, no remote code execution, and no analytics tracking.
*   **No Data Harvesting:** FormAnchor never uploads your Excel data or recorded form scripts anywhere.
*   **IndexedDB Local Storage:** Large data volumes and execution logs are stored securely in local browser IndexedDB instances, bypassing the volatile 10MB chrome.storage limit.

---

## 3. Search Keywords (Tags - Max 5)

*These 5 keywords are selected for the primary Chrome Web Store submission to maximize visibility for high-intent search queries:*

1.  **Form Filler** (Direct search for filling forms)
2.  **Excel Auto-Fill** (Targets the unique Excel-driven automation workflow)
3.  **Web Automation** (Broader category target for general browser task runners)
4.  **Data Entry** (Targets administrative and repetitive typing workloads)
5.  **Browser Automation** (High-intent search for RPA and macro-like tools)

### Alternative & Backup Keywords (For SEO, Metadata, and Rotation)
*Use these alternatives for A/B testing store listings or in website SEO metadata:*
*   **Auto Form Filler**
*   **Bulk Form Filler**
*   **Excel to Web Form**
*   **RPA Tool** (Robotic Process Automation)
*   **Data Entry Automation**
*   **Spreadsheet AutoFill**
*   **No-Code Automation**
*   **Form Automator**
*   **Web Scraper** (Useful if users search for scrapers to do form filling)

---

## 4. Promo Tiles & Screenshots Plan

*Note: Upload these image assets directly in the **Chrome Web Store Developer Console** under the Store Listing tab. The screenshots listed below have been freshly generated from the latest built extension, capturing the redesigned UI/UX dashboard pages (1280x800 resolution) located in the local [live_demo_screenshots/](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots) folder.*

*   **Screenshot 1 (The Dashboard):** Clean React-based HomeScreen showing the list of active recordings, the "Record New Flow" CTA, and a drag-and-drop zone for Excel uploads. *(Recommended source: [01_dashboard_home.png](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots/01_dashboard_home.png))*
*   **Screenshot 2 (Excel Column Mapping):** DataScreen interface showing a list of Excel columns matched via Levenshtein fuzzy distance to form fields, with color-coded confidence badges. *(Recommended source: [02_excel_mapping.png](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots/02_excel_mapping.png))*
*   **Screenshot 3 (Active Run Progress):** RunScreen displaying active progression radial indicators, rows succeeded/skipped counters, and live-scrolling execution logs. *(Recommended source: [03_run_progress.png](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots/03_run_progress.png))*
*   **Screenshot 4 (Activity Logs):** LogScreen displaying the split-pane session view, status indicators, and detailed log records. *(Recommended source: [04_activity_logs.png](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots/04_activity_logs.png))*
*   **Screenshot 5 (Settings Page):** SettingsScreen showcasing the balanced, responsive card layouts and diagnostics logs configuration. *(Recommended source: [05_settings_page.png](file:///d:/SACHIN%20RAWAL%20FILES/FormPilot/live_demo_screenshots/05_settings_page.png))*

