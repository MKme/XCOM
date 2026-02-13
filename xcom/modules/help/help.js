/**
 * Help Module
 * Provides documentation and help for XCOM™
 */

class HelpModule {
    constructor() {
        this.init();
    }
    
    init() {
        // Create module HTML structure
        this.createModuleStructure();
        
        // Bind events
        this.bindEvents();
        
        // Update status
        window.radioApp.updateStatus('Help module loaded');
    }
    
    createModuleStructure() {
        const moduleContainer = document.getElementById('help');
        
        moduleContainer.innerHTML = `
            <div class="help-container">
                <div class="help-section help-intro">
                    <h2>Made with love (and late nights) by Eric VE3YLO</h2>
                    <p>
                        XCOM™ is written by <strong>Eric (VE3YLO)</strong> and is designed for <strong>everyone</strong> to enjoy.
                        Thank you for supporting a <em>single creator</em> &mdash; not a corporation.
                    </p>
                    <p>
                        Your purchase helps fund more open-source projects and educational videos.
                        If you’d like to see what I’m building next, you can find me here:
                    </p>
                     <ul>
                         <li><a href="https://mkme.org" target="_blank" rel="noreferrer">mkme.org</a></li>
                         <li><a href="https://mkme.org/xcom/" target="_blank" rel="noreferrer">mkme.org/xcom (XCOM downloads/updates)</a></li>
                         <li><a href="https://www.youtube.com/mkmeorg" target="_blank" rel="noreferrer">youtube.com/mkmeorg</a></li>
                         <li><a href="https://www.youtube.com/@TacTechTrail" target="_blank" rel="noreferrer">TacTechTrail</a></li>
                     </ul>
                    <p>
                        I hope you have a great time using XCOM™ &mdash; and genuinely, thanks for being part of making more tools like this possible.
                    </p>
                </div>

                <div class="help-section help-disclaimer">
                    <h2>Data & Offline Use Disclaimer</h2>
                    <p>
                        This toolkit relies on datasets that are inherently out of date the moment they are published. 
                        Repeaters move, licences change, and many of the source datasets are hard to obtain, so the 
                        information in this tool may be inaccurate, incomplete, or no longer maintained at any given time.
                        It is provided strictly as-is, without warranty or support. That is part of the fun (and challenge)
                        of planning for an offline world &mdash; it is not easy.
                    </p>
                </div>

                <div class="help-section">
                    <h2>XCOM™</h2>
                    <p>Welcome to XCOM™, a comprehensive application for amateur radio operators. This toolkit provides various modules to assist with your amateur radio activities.</p>
                </div>
                
                <div class="help-section">
                    <h2>Install / Updates / Licensing</h2>

                    <h3>License activation (required)</h3>
                    <p>
                        On the public XCOM page (<a href="https://mkme.org/xcom/" target="_blank" rel="noreferrer">mkme.org/xcom</a>), XCOM&trade; requires a <strong>one-time license activation</strong>.
                        Enter your license key once while online; after activation, XCOM&trade; works offline on this device.
                    </p>
                    <ul>
                        <li><strong>First activation requires internet access.</strong></li>
                        <li>If you clear browser/site data (or uninstall the PWA), you will need to activate again <strong>and</strong> you will lose local data unless you exported a backup first.</li>
                    </ul>

                    <h3>Updates</h3>
                    <ul>
                        <li>Use the <strong>Update</strong> button in the top bar to check for an update and reload.</li>
                        <li>Updates do <strong>not</strong> wipe your local data.</li>
                        <li>If the app seems stuck on an old version, use <strong>Backup</strong> &rarr; <strong>Repair app cache</strong> (keeps data) instead of clearing site data.</li>
                        <li>If the license server is reachable, Update re-checks your cached key and only blocks if the key is <strong>invalid</strong>.</li>
                        <li>If the license server is unreachable, Update still reloads and continues using your cached activation on this device.</li>
                    </ul>

                    <h3>Install for offline use (PWA)</h3>
                    <ul>
                        <li><strong>Android/Desktop:</strong> browser menu &rarr; <strong>Install app</strong></li>
                        <li><strong>iPhone/iPad:</strong> Safari &rarr; Share &rarr; <strong>Add to Home Screen</strong></li>
                    </ul>
                    <p>
                        Tip: open XCOM&trade; once while online so the app shell can be cached. After that, it can launch offline.
                    </p>
                </div>

                <div class="help-section">
                    <h2>Available Modules</h2>
                    <div class="module-list">
                        <div class="module-card">
                            <h3>Predict</h3>
                            <p>Offline lookup for USA/Canada callsigns, plus path plotting, great-circle distance, and VOACAP-style propagation estimates (including forecasts and band/mode graphs).</p>
                        </div>
                        <div class="module-card">
                            <h3>Ham Clock (Experimental)</h3>
                            <p>UTC-first ham clock with greyline/day-night map, DE/DX path, and a lightweight band prediction model. Space weather fetch is optional.</p>
                        </div>
                        <div class="module-card">
                            <h3>Packet Stations</h3>
                            <p>Offline Packet Radio reference: common frequencies, plus a map and list of packet nodes and BBS. Includes import/export for your local node list.</p>
                        </div>
                        <div class="module-card">
                            <h3>XTOC Comm</h3>
                            <p>XTOC-compatible packet workshop + import bridge: generate CLEAR/SECURE packets, chunk for transport limits, QR export/scan, mesh/MANET send, and import XTOC backups (roster + keys + packets).</p>
                        </div>
                        <div class="module-card">
                            <h3>XTOC Data</h3>
                            <p>Local packet archive: browse/search all stored XTOC packets (including non-location), copy raw wrappers/summaries, and import geo packets to the tactical map.</p>
                        </div>
                        <div class="module-card">
                            <h3>Logbook</h3>
                            <p>Quick QSO logbook with auto UTC timestamps, local-only storage, and ADIF/CSV export for uploading (including POTA tagging fields).</p>
                        </div>
                        <div class="module-card">
                            <h3>ASCII Art</h3>
                            <p>Make simple ASCII banners for packet radio messages. Adjust scale, ink character, spacing, and optional borders; then copy/paste into your terminal/BBS.</p>
                        </div>
                        <div class="module-card">
                            <h3>Repeater Map</h3>
                            <p>Find amateur radio repeaters on an interactive map. Search by location, filter by band and mode, and get detailed information about repeaters in your area.</p>
                        </div>
                        <div class="module-card">
                            <h3>Mesh</h3>
                            <p>Connect to a Meshtastic or MeshCore device (Web Bluetooth), configure destination/channel, send test messages, and view inbound/outbound traffic. XTOC Comm can send generated packets directly over the mesh.</p>
                        </div>
                        <div class="module-card">
                            <h3>Map</h3>
                            <p>XTOC-style tactical map with optional offline raster tile caching, plus an Imported overlay for XTOC packet markers/zones with XTOC-style icons and per-type toggles (last 7 days rendered by default).</p>
                        </div>
                        <div class="module-card">
                            <h3>Help</h3>
                            <p>Access documentation and help for XCOM™. Learn how to use the various modules and features.</p>
                        </div>
                        <div class="module-card">
                            <h3>Backup</h3>
                            <p>Export/import your local XCOM data so you can recover after clearing site data or reinstalling the PWA.</p>
                        </div>
                        <!-- Additional modules will be added here -->
                    </div>
                </div>

                <div class="help-section">
                    <h2>Ham Clock Module (Experimental)</h2>
                    <h3>Overview</h3>
                    <p>
                        Ham Clock is a UTC-first ham radio dashboard with a live greyline/day-night map and a lightweight propagation “at a glance” model.
                        It is designed to be useful offline (manual SFI) and even better online (optional NOAA SpaceWx fetch).
                    </p>

                    <h3>Key Features</h3>
                    <ul>
                        <li><strong>Greyline map:</strong> terminator shading + optional greyline band, grid, time labels, and subsolar marker.</li>
                        <li><strong>DE/DX path:</strong> set your location (DE) and a target (DX) to draw a great-circle path and see distance.</li>
                        <li><strong>Bands (predicted):</strong> quick band strip + prediction details based on SFI, mode, power, and DE↔DX distance.</li>
                        <li><strong>Space weather (optional):</strong> click <strong>Fetch</strong> to load SFI/SSN/A/Kp when online.</li>
                    </ul>

                    <h3>How to Use</h3>
                    <ol>
                        <li>Set <strong>DE</strong>: type <code>lat,lng</code> and click <strong>Set DE</strong> (or click <strong>Pick</strong> then click the map).</li>
                        <li>Set <strong>DX</strong>: same idea &mdash; <strong>Set DX</strong> or <strong>Pick</strong>.</li>
                        <li>Adjust <strong>SFI</strong>, <strong>Mode</strong>, and <strong>Pwr</strong> to match your station.</li>
                        <li>(Optional) Open <strong>Display options</strong> to toggle terminator/greyline/grid overlays.</li>
                    </ol>
                </div>

                <div class="help-section">
                    <h2>Packet Stations Module</h2>
                    <h3>Overview</h3>
                    <p>
                        Packet Stations is an offline-first reference for packet nodes and BBS entries, with a built-in map and a “common frequencies” quick table.
                        It also supports maintaining your own local node list.
                    </p>

                    <h3>Features</h3>
                    <ul>
                        <li><strong>Search by AO:</strong> enter a place name or <code>lat,lng</code>, use <strong>Current Location</strong>, or <strong>Pick on map</strong>.</li>
                        <li><strong>Filters:</strong> type (Node/BBS), radius (including “Any distance”), and text search.</li>
                        <li><strong>Local list maintenance:</strong> import/export a JSON file of your custom nodes; stored locally on your device.</li>
                    </ul>

                    <h3>Operational Notes</h3>
                    <ul>
                        <li>Distance filters are for convenience &mdash; HF/packet paths can exceed “local” distances.</li>
                        <li>Always verify your local band plan before transmitting.</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>XTOC Comm Module</h2>
                    <h3>Overview</h3>
                    <p>
                        XTOC Comm is an XTOC-compatible packet workshop and import bridge: create standardized reports, chunk them for transport limits, and move them via copy/paste, Voice (TTS), QR, Mesh, or MANET (LAN).
                        It also supports importing XTOC exports so field devices have roster labels, SECURE keys (KID), and packet history for offline operations.
                    </p>

                    <h3>Creating packets</h3>
                    <ul>
                        <li><strong>Templates:</strong> T=1&ndash;8 (SITREP/CONTACT/TASK/CHECKIN/RESOURCE/ASSET/ZONE/MISSION).</li>
                        <li><strong>Modes:</strong> <strong>CLEAR</strong> (human-readable fields) or <strong>SECURE</strong> (encrypted).</li>
                        <li><strong>Transport profiles:</strong> choose Copy/Paste, Voice (TTS), JS8/APRS, Winlink, Meshtastic/MeshCore, MANET (LAN), or QR &mdash; then click <strong>Generate</strong>.</li>
                        <li><strong>Location tools:</strong> <strong>Use GPS</strong> fills Lat/Lon from your device; <strong>Pick Location</strong> and <strong>Draw Zone</strong> open a mini-map so you can embed coordinates/areas into packets.</li>
                    </ul>

                    <h3>SECURE mode (keys)</h3>
                    <ul>
                        <li>SECURE requires a team key. Import an <code>XTOC-KEY</code> bundle (paste/QR) or import an XTOC backup (keys are matched by <code>KID</code>).</li>
                        <li>Keys are stored locally on your device under the <code>xcom.xtoc.*</code> localStorage namespace.</li>
                    </ul>

                    <h3>Moving packets</h3>
                    <ul>
                        <li><strong>Copy</strong> puts the generated packet lines on your clipboard.</li>
                        <li><strong>Output Voice</strong> spells out the packet text character-by-character for manual voice relays (Voice transport).</li>
                        <li><strong>Make QR</strong> renders a scannable QR for the first packet line (best for QR/Copy-Paste transports).</li>
                        <li><strong>Scan QR</strong> (Import/Reassemble) reads packet lines from camera and decodes them.</li>
                        <li><strong>Send via Mesh</strong> sends each generated packet line as a mesh text message (Meshtastic or MeshCore; requires Mesh connected).</li>
                        <li><strong>Send via MANET</strong> sends the generated packet text over LAN via the XTOC MANET bridge (requires MANET connected).</li>
                    </ul>

                    <h3>XTOC &rarr; XCOM import (field handoff)</h3>
                    <p>
                        Use this when you want to hand field devices everything they need from an XTOC export: team roster labels, SECURE keys (KID), and packet history.
                        Imports <strong>merge</strong> into existing local data (no wipes).
                    </p>
                    <ol>
                        <li>In XTOC: Topbar &rarr; <strong>Export</strong> to download <code>xtoc-backup-*.json</code>.</li>
                        <li>In XCOM: <strong>XTOC Comm</strong> &rarr; <strong>XTOC &rarr; XCOM Import</strong> &rarr; <strong>Import Backup</strong>.</li>
                    </ol>
                    <ul>
                        <li><strong>Roster:</strong> imports full member records and prefers <code>label</code> for friendly display.</li>
                        <li><strong>Keys:</strong> imports team keys by <code>KID</code> so SECURE packets can be decrypted/decoded.</li>
                        <li><strong>Packets:</strong> stores all packets (including non-location) in <strong>XTOC Data</strong>; geo packets are also added to the Map <strong>Imported</strong> overlay.</li>
                    </ul>
                    <p>
                        <strong>Map note:</strong> Imported overlay hides markers older than 7 days by default (uses packet timestamp when available, otherwise received/import time). Toggle this in <strong>Map</strong> &rarr; <strong>Overlays</strong>.
                    </p>

                    <h3>Team roster bundle (labels only)</h3>
                    <p>
                        If you only need friendly labels (no packets/keys), import the roster bundle from XTOC:
                    </p>
                    <ul>
                        <li>In XTOC: <strong>Team</strong> &rarr; <strong>Transfer</strong> &rarr; copy the <code>XTOC-TEAM.</code> bundle (or show the QR).</li>
                        <li>In XCOM: <strong>XTOC Comm</strong> &rarr; paste into <strong>Team roster bundle</strong> and click <strong>Import Team</strong> (or <strong>Scan Team QR</strong>).</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>XTOC Data Module</h2>
                    <h3>Overview</h3>
                    <p>
                        XTOC Data is a local-first packet archive. It lists and searches <strong>all</strong> stored XTOC packets on this device &mdash; including non-location packets.
                        Packets are stored in your browser&rsquo;s IndexedDB (no cloud, no accounts).
                    </p>

                    <h3>What you can do</h3>
                    <ul>
                        <li><strong>Browse/search:</strong> filter by time window, source, and whether the packet has GEO.</li>
                        <li><strong>Inspect:</strong> view raw wrapper, decoded JSON (when available), and any decode errors.</li>
                        <li><strong>Copy:</strong> copy raw wrapper or summary for sharing.</li>
                        <li><strong>Import to map:</strong> for packets with GEO features, add them to the Map <strong>Imported</strong> overlay.</li>
                    </ul>
                </div>

                <div class="help-section help-upgrade">
                    <h2>Upgrade: Get XTOC&trade; (complete the comms loop)</h2>
                    <p>
                        XCOM is the field toolkit. XTOC&trade; is the Tactical Operations Center app that receives what you send and turns it into a shared picture.
                        Together they make your comms complete: field reports &rarr; transport &rarr; TOC timeline + tactical map.
                    </p>
                    <ul>
                        <li><strong>Import + organize:</strong> ingest packets and keep a local incident log.</li>
                        <li><strong>Map + timelines:</strong> see check-ins, reports, zones, and missions on a shared operational picture.</li>
                        <li><strong>Field handoff:</strong> export an XTOC backup and import it into XCOM to preload roster labels, SECURE keys (KID), and packet history for off-grid devices.</li>
                        <li><strong>Local-first:</strong> install it and it keeps working offline (no accounts, no server required).</li>
                    </ul>
                    <p>
                        <a class="xTopbarBtn" href="https://store.mkme.org/product/xtoc-tactical-operations-center-software-suite/" target="_blank" rel="noopener noreferrer" title="Buy XTOC (Tactical Operations Center)">Get XTOC</a>
                    </p>
                </div>

                <div class="help-section">
                    <h2>Map Module</h2>
                    <h3>Overview</h3>
                    <p>
                        The Map module is an XTOC-style tactical basemap with optional offline raster tile caching.
                        Pan/zoom to define your AO and download tiles so the map still works without internet.
                    </p>

                     <h3>Offline raster tiles (cache)</h3>
                     <ol>
                        <li>Set <strong>Base</strong> to <strong>Topographic</strong>, <strong>Topographic Dark</strong>, <strong>Offline Raster (cached)</strong>, or <strong>Offline Raster Dark (cached)</strong>.</li>
                        <li>(Optional) If using <strong>Offline Raster</strong>, change the <strong>Raster tile URL template</strong> to your own tile server.</li>
                        <li>Pan/zoom until the <strong>Current AO bounds</strong> covers what you need.</li>
                        <li>Set <strong>Min zoom</strong>, <strong>Max zoom</strong>, and <strong>Max tiles</strong> (safety), then click <strong>Download tiles</strong>.</li>
                        <li>Use <strong>Test cached tile</strong> to verify that your current center tile is cached.</li>
                        <li>Use <strong>Clear tiles</strong> to free storage.</li>
                     </ol>
                     <ul>
                        <li>Tiles are stored in the browser <strong>Cache Storage</strong> cache named <code>xtoc.tiles.v1</code>.</li>
                        <li>Keep AO + zoom ranges reasonable &mdash; tile downloads can get large quickly.</li>
                    </ul>

                    <h3>Imported overlay (XTOC packets)</h3>
                    <ul>
                        <li><strong>What it is:</strong> Imported markers/zones are XTOC packet locations/zones that you imported into XCOM.</li>
                        <li><strong>Where it comes from:</strong> <strong>XTOC Comm</strong> &rarr; <strong>Import</strong> (single packet) and <strong>XTOC Comm</strong> &rarr; <strong>XTOC &rarr; XCOM Import</strong> &rarr; <strong>Import Backup</strong> (roster + keys + packets).</li>
                        <li><strong>Controls:</strong> open <strong>Map</strong> &rarr; <strong>Overlays</strong> and toggle <strong>Imported</strong>, <strong>Last 7 days only</strong>, and the per-type filters (SITREP/CONTACT/TASK/CHECKIN/RESOURCE/ASSET/ZONE/MISSION).</li>
                        <li><strong>7-day filter:</strong> this is render-only (older packets remain stored locally). It uses packet timestamp when available, otherwise received/import time.</li>
                        <li><strong>Friendly labels:</strong> popups use team roster labels when available (import via <strong>Import Team</strong> or <strong>Scan Team QR</strong>).</li>
                        <li><strong>Hide from map:</strong> click an Imported marker and choose <strong>Hide from map</strong> to declutter without deleting. Restore items under <strong>Map</strong> &rarr; <strong>Overlays</strong> &rarr; <strong>Hidden</strong> (enable the toggle to plot hidden markers, then click a marker &rarr; <strong>Unhide</strong>).</li>
                        <li><strong>Packet archive:</strong> all packets (including non-location) are stored in <strong>XTOC Data</strong>; geo packets can be imported to the map from there too.</li>
                    </ul>

                    <h3>Mesh nodes overlay (Meshtastic / MeshCore / OpenMANET)</h3>
                    <ul>
                        <li><strong>Enable:</strong> open <strong>Map</strong> &rarr; <strong>Overlays</strong> and toggle <strong>Mesh nodes</strong>.</li>
                        <li><strong>Meshtastic/MeshCore:</strong> plots the latest GPS packets seen in Mesh traffic/imports as map markers.</li>
                        <li><strong>OpenMANET:</strong> set <strong>OpenMANET API URL</strong> (example <code>http://10.0.0.1:8087</code>) and <strong>OpenMANET refresh (ms)</strong> to poll node positions.</li>
                        <li><strong>Assign to roster:</strong> click a node marker and pick a Team member in the popup (requires a roster import via <strong>Import Team</strong>, <strong>Scan Team QR</strong>, or an XTOC backup import).</li>
                        <li><strong>CORS tip:</strong> if the browser blocks OpenMANET polling, connect to the XTOC MANET bridge; XCOM will proxy OpenMANET requests through the bridge.</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>ASCII Art Module</h2>
                    <h3>Overview</h3>
                    <p>
                        ASCII Art generates simple text banners you can paste into packet messages, BBS posts, terminal notes, or logs.
                        It works fully offline (no external dependencies).
                    </p>
                    <h3>Tips</h3>
                    <ul>
                        <li>Keep line lengths reasonable for your transport (JS8/APRS/BBS).</li>
                        <li>Use a single “ink” character (e.g., <code>#</code>, <code>*</code>, <code>@</code>) and adjust spacing/border as needed.</li>
                        <li>Click <strong>Copy</strong> to put the output on your clipboard.</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>Mesh Module</h2>
                    <h3>Overview</h3>
                    <p>
                        The Mesh module connects XCOM™ to <strong>Meshtastic</strong> or <strong>MeshCore</strong> radios.
                        It is designed for offline field use and stores your mesh settings locally.
                    </p>

                    <h3>Requirements</h3>
                    <ul>
                        <li><strong>Web Bluetooth:</strong> works in Chrome/Edge (desktop and Android). Not supported in iOS Safari.</li>
                        <li>A Meshtastic or MeshCore device with Bluetooth enabled.</li>
                    </ul>

                    <h3>How to Use</h3>
                    <ol>
                        <li>Open <strong>Mesh</strong> and click <strong>Connect</strong>.</li>
                        <li>Choose <strong>Broadcast</strong> (channel) or <strong>Direct</strong> (id), set your channel and (Meshtastic only) ACK preference.</li>
                        <li>Send a <strong>Test message</strong> and confirm it appears in the Traffic log.</li>
                        <li>Open <strong>XTOC Comm</strong>, generate packets, then click <strong>Send via Mesh</strong> to transmit each packet line as a mesh text message.</li>
                    </ol>

                    <h3>Notes & Troubleshooting</h3>
                    <ul>
                        <li>If the browser cannot see your device, confirm Bluetooth is on and the device is not already connected to another client.</li>
                        <li>If messages appear truncated, choose the <strong>Meshtastic (180 chars)</strong> or <strong>MeshCore (160 bytes)</strong> transport profile in XTOC Comm before generating.</li>
                        <li>Traffic and settings are stored locally under <code>xcom.mesh.*</code> keys in localStorage.</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>MANET Module</h2>
                    <h3>Overview</h3>
                    <p>
                        The MANET module connects XCOM to the XTOC MANET bridge over an IP network (Wi-Fi HaLow / Open MANET / trusted LAN).
                        It provides a simple LAN link for sending and receiving XTOC packet text without chunking (recommended for fast local field networks).
                    </p>

                    <h3>How to Use</h3>
                    <ol>
                        <li>On the XTOC (master) laptop, start the bridge: <code>halow-bridge/Start-XTOC-MANET-Bridge.cmd</code> (or <code>halow-bridge/Start-XTOC-HaLow-Bridge.ps1</code>) (bind to <code>0.0.0.0:8095</code>). The browser app cannot start this for you.</li>
                        <li>On the XTOC laptop, open <strong>MANET</strong> and click <strong>Share Bridge QR</strong>.</li>
                        <li>On this device, open <strong>MANET</strong> and click <strong>Scan Bridge QR</strong> (recommended; allow camera access) or set Bridge URL to the XTOC IP (example: <code>http://10.0.0.5:8095</code>).</li>
                        <li>Click <strong>Connect</strong> and confirm your device appears in the Topology list.</li>
                        <li>In <strong>XTOC Comm</strong>, select <strong>MANET (LAN)</strong> and click <strong>Send via MANET</strong>.</li>
                    </ol>

                    <h3>Notes</h3>
                    <ul>
                        <li>This is designed for trusted LANs only (the bridge has permissive CORS and no authentication by design).</li>
                        <li><strong>Bridge helper:</strong> the bridge is a tiny Python program. Install Python 3 on the XTOC laptop and run the launcher scripts in <code>halow-bridge/</code>.</li>
                        <li><strong>Release bundles:</strong> the downloadable web fileset ZIP includes <code>halow-bridge/</code> alongside the app files.</li>
                        <li>Bridge URL cannot be <code>0.0.0.0</code> (bind address). Use the XTOC laptop IP or <code>http://127.0.0.1:8095</code> on the laptop.</li>
                        <li>If <strong>Share Bridge QR</strong> / <strong>Scan Bridge QR</strong> says <em>Failed to fetch</em>, the bridge is usually not running yet, the Bridge URL is wrong, or the browser is blocking the request.</li>
                        <li>Troubleshooting: from any device browser, open <code>http://&lt;XTOC-IP&gt;:8095/health</code>. If it wonâ€™t load, check that both devices are on the same MANET/LAN and that Windows Firewall allows inbound port 8095.</li>
                        <li>If the app is running on <code>https://</code> and the bridge is <code>http://</code>, some browsers may block the connection. For field use, run the apps from the local web fileset (<code>http://localhost</code> / LAN HTTP) or use a secure bridge origin.</li>
                        <li>Traffic and settings are stored locally under <code>xcom.halow.*</code> keys in localStorage.</li>
                    </ul>
                </div>

                <div class="help-section">
                    <h2>Logbook Module</h2>
                    <h3>Overview</h3>
                    <p>
                        The Logbook module is a lightweight, offline-first QSO logger designed for fast entry in the field.
                        It automatically fills the Start time using <strong>UTC</strong> and stores your QSOs locally in your browser/Electron profile.
                    </p>

                    <h3>Quick Entry Tips</h3>
                    <ul>
                        <li><strong>UTC timestamps:</strong> the logbook stores a single QSO time (TIME_ON) in UTC for fast, standard logging.</li>
                        <li><strong>Time of save:</strong> by default the Logbook stamps the QSO time when you click <strong>Save QSO</strong> (so it’s always accurate even if the form has been open awhile).</li>
                        <li><strong>Manual override:</strong> if you edit the Start field, the Logbook will respect your manual time instead of auto-stamping.</li>
                        <li><strong>Fast save:</strong> enter the callsign and hit <kbd>Enter</kbd> to save.</li>
                        <li><strong>Defaults:</strong> set “Default My call”, “Default band”, “Default mode”, and your activation reference once, then save QSOs faster.</li>
                        <li><strong>Local only:</strong> nothing is uploaded. Export to share or upload elsewhere.</li>
                    </ul>

                    <h3>Offline UTC correction (if your device clock is wrong)</h3>
                    <p>
                        Since this app is designed to be used fully offline, your device clock may not always be accurate.
                        The Logbook includes a UTC correction so you can adjust the time used for stamping QSOs.
                    </p>
                    <ul>
                        <li><strong>UTC correction (sec):</strong> add/subtract seconds from the system clock. Example: if your device is 2 minutes slow, enter <code>120</code>.</li>
                        <li><strong>Set UTC now (manual):</strong> enter the actual current UTC time (from GPS, radio, another device) and click “Set from manual UTC” to automatically compute the correction.</li>
                        <li>The correction is saved locally and will persist until you reset it.</li>
                    </ul>

                    <h3>POTA / Awards fields explained (ADIF)</h3>
                    <p>
                        ADIF supports “signature” fields to tag award programs.
                        The Logbook uses the standard ADIF fields so you can upload to POTA and other services.
                    </p>
                    <ul>
                        <li><strong>MY_SIG</strong>: the program you are activating (your signature), e.g. <code>POTA</code>, <code>SOTA</code>, <code>IOTA</code>.</li>
                        <li><strong>MY_SIG_INFO</strong>: your reference for that program, e.g. <code>CA-1234</code>.</li>
                        <li><strong>SIG</strong> / <strong>SIG_INFO</strong>: optional “other party / QSO signature” fields. In this app, if you fill <em>POTA ref (optional)</em>, the export sets <code>SIG=POTA</code> and <code>SIG_INFO=&lt;ref&gt;</code>.</li>
                    </ul>

                    <h3>Export formats</h3>
                    <ul>
                        <li><strong>ADIF (.adi):</strong> the standard ham log interchange format. Best choice for POTA uploads and moving logs between apps.</li>
                        <li><strong>CSV (.csv):</strong> a simple spreadsheet-friendly export using consistent headers (derived from the same data used to generate ADIF).</li>
                    </ul>

                    <h3>Data storage</h3>
                    <p>
                        The Logbook stores QSOs in localStorage under <code>logbook.qsos.v1</code> and your defaults under <code>logbook.prefs.v1</code>.
                        Clearing your browser/Electron profile will remove them, so export your QSOs if you need a backup.
                    </p>
                </div>
                
                <div class="help-section">
                    <h2>Repeater Map Module</h2>
                    <h3>Overview</h3>
                    <p>The Repeater Map module allows you to find amateur radio repeaters on an interactive map. You can search for repeaters near a specific location, filter by band and mode, and get detailed information about each repeater.</p>
                    
                    <h3>Features</h3>
                    <ul>
                        <li><strong>Location Search:</strong> Enter a city, state/province, or use your current location to find nearby repeaters.</li>
                        <li><strong>Filtering:</strong> Filter repeaters by band (2m, 70cm, etc.) and mode (FM, DMR, D-STAR, etc.).</li>
                        <li><strong>Radius Control:</strong> Adjust the search radius to find repeaters within a specific distance.</li>
                        <li><strong>Detailed Information:</strong> View detailed information about each repeater, including frequency, offset, tone, and more.</li>
                        <li><strong>Interactive Map:</strong> Visualize repeater locations on an interactive map.</li>
                    </ul>
                    
                    <h3>How to Use</h3>
                    <ol>
                        <li>Enter a location in the search box or click "Use Current Location".</li>
                        <li>Adjust the filters as needed to narrow down the results.</li>
                        <li>Click on a repeater marker on the map or in the list to view detailed information.</li>
                    </ol>
                </div>

                <div class="help-section">
                    <h2>Predict Module</h2>
                    <h3>Overview</h3>
                    <p>Search USA/Canada callsigns offline (after running the one-time dataset fetch), geocode their QTH, draw a great-circle path to your station, calculate distance, and get VOACAP-style band/mode recommendations with forecasts.</p>

                    <h3>Key Features</h3>
                    <ul>
                        <li><strong>Band & mode model:</strong> Lightweight VOACAP-style scoring for 80–10&nbsp;m that combines path length, time of day (day/night/greyline), season, solar flux and mode to rank likely bands.</li>
                        <li><strong>Current UTC-first:</strong> Predict resets to current UTC for the initial estimate; a “Use current UTC” button sets the time input instantly.</li>
                        <li><strong>Your station + target path:</strong> Enter your location (city/lat,lng or GPS) and a callsign; the app geocodes the license location, draws a line, and reports distance in mi/km.</li>
                        <li><strong>VOACAP-style estimate:</strong> Uses path length, UTC, Solar Flux Index (SFI), mode, and transmit power (default 8 W) to rank bands.</li>
                        <li><strong>Forecast window:</strong> Pick horizon (hours) to see future best windows.</li>
                        <li><strong>Graphs:</strong> Main chart shows selected-mode bands over time; below it, per-band charts plot all modes for that band to compare mode reliability.</li>
                        <li><strong>Solar flux fetch:</strong> Optional SFI fetch from wm7d.net; falls back to manual SFI entry if offline or blocked.</li>
                        <li><strong>City lookup:</strong> Use a city/state instead of a callsign; the app geocodes the city center and runs the same path/distance/propagation flow.</li>
                    </ul>

                    <h3>How to Use</h3>
                    <ol>
                        <li>Set your station: enter city/lat,lng or click “Use GPS”.</li>
                        <li>Enter callsign and click Predict. The module sets UTC to now, geocodes the target, draws the path, and shows distance.</li>
                        <li>Adjust inputs if needed: SFI, UTC, Mode (SSB/Digital/FM), Power (W), Forecast hours.</li>
                        <li>Review outputs:
                            <ul>
                                <li><em>VOACAP-style estimate:</em> current best bands and notes (band range, diurnal, solar, power, greyline).</li>
                                <li><em>Forecast tiles:</em> top band per time slot.</li>
                                <li><em>Main chart:</em> selected-mode bands over time with inline labels.</li>
                                <li><em>Per-band charts:</em> each band shows SSB/Digital/FM lines to compare modes.</li>
                            </ul>
                        </li>
                    </ol>

                    <h3>Tips</h3>
                    <ul>
                        <li>Keep SFI realistic; 60–200 is typical. Low power favors Digital; higher power lifts all modes slightly.</li>
                        <li>If geocoding fails offline, enter target lat,lng manually as your “station” and note distance separately.</li>
                        <li>Forecast horizon up to 72h; step size adapts automatically.</li>
                        <li>SFI fetch may be blocked by network policies; manual entry is always available.</li>
                    </ul>

                    <h3>Propagation Model Notes</h3>
                    <ul>
                        <li><strong>Bands:</strong> Models 80–10&nbsp;m with a preferred distance window for each band plus day/night/greyline behavior. Lower bands favor night and NVIS/medium hops; higher bands favor daytime and longer paths, with an extra boost around sunrise/sunset.</li>
                        <li><strong>Modes:</strong> SSB/CW is the baseline. Digital (FT8/JS8) is treated as more efficient on marginal paths (slight score lift), and FM gets a small bonus on 10&nbsp;m when the band is open.</li>
                        <li><strong>Solar flux (SFI):</strong> Feeds a 0–1 "solar factor". Higher SFI mainly lifts 20–10&nbsp;m, with a smaller effect on 40&nbsp;m and below; very low SFI pushes the model toward lower bands and digital/CW.</li>
                        <li><strong>Power / wattage:</strong> The Power (W) slider scales reliability with a gentle logarithmic curve between QRP and 100–200&nbsp;W. More power helps, but with diminishing returns, and scores are capped so extra watts cannot turn a completely closed band into a guaranteed path.</li>
                        <li><strong>Charts:</strong> The main chart shows only bands for the currently selected mode over time. The per-band charts fix a band (e.g., 20&nbsp;m) and draw SSB, Digital, and FM curves together so you can compare how that band behaves by mode.</li>
                    </ul>
                </div>
                
                <div class="help-section">
                    <h2>Keyboard Shortcuts</h2>
                    <table class="keyboard-shortcuts">
                        <thead>
                            <tr>
                                <th>Shortcut</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">1</span></td>
                                <td>Switch to Predict module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">2</span></td>
                                <td>Switch to Ham Clock module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">3</span></td>
                                <td>Switch to Packet Stations module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">4</span></td>
                                <td>Switch to XTOC Comm module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">5</span></td>
                                <td>Switch to Mesh module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">6</span></td>
                                <td>Switch to Logbook module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">7</span></td>
                                <td>Switch to ASCII Art module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">8</span></td>
                                <td>Switch to Repeater Map module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">9</span></td>
                                <td>Switch to Map module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Alt</span> + <span class="keyboard-shortcut-key">0</span></td>
                                <td>Switch to Help module</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Ctrl</span> + <span class="keyboard-shortcut-key">F</span></td>
                                <td>Focus on search box (in Repeater Map)</td>
                            </tr>
                            <tr>
                                <td><span class="keyboard-shortcut-key">Esc</span></td>
                                <td>Clear selection</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                
                <div class="help-section">
                    <h2>About</h2>
                    <p>XCOM™ v1.0.36</p>
                    <p>&copy; 2025 - All rights reserved</p>
                    <p>This application is designed for amateur radio operators to assist with various radio-related tasks. It is continually being improved with new features and modules.</p>

                    <p align="center">
                        🐦 <a href="https://twitter.com/mkmeorg">Twitter</a>
                        | 📺 <a href="https://www.youtube.com/mkmeorg">YouTube</a>
                        | 📺 <a href="https://www.youtube.com/@tactechtrail">TacTechTrail</a>
                        | 🌍 <a href="https://mkme.org/xcom/">mkme.org/xcom</a><br>
                        <br>
                        Support this project and become a patron on <a href="https://www.patreon.com/EricWilliam">Patreon</a>.<br>
                        Chat: <a href="https://mkme.org/discord" target="_blank" rel="noreferrer">Discord</a>!
                    </p>
                </div>
            </div>
        `;

        // Add a plain-English module intro without touching the large HTML block above.
        try {
            const root = moduleContainer.querySelector('.help-container');
            if (root && !root.querySelector('.xModuleIntro')) {
                root.insertAdjacentHTML('afterbegin', `
                    <div class="xModuleIntro">
                        <div class="xModuleIntroTitle">What you can do here</div>
                        <div class="xModuleIntroText">
                            Use this page as a quick-start guide: what each module does, offline notes, and keyboard shortcuts.
                        </div>
                    </div>
                `);
            }
        } catch (_) {
            // ignore
        }
    }
    
    bindEvents() {
        // Add keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Alt + 1: Switch to Predict
            if (e.altKey && e.key === '1') {
                const link = document.querySelector('a[data-module="callsign-lookup"]');
                if (link) link.click();
            }
            
            // Alt + 2: Switch to Ham Clock
            if (e.altKey && e.key === '2') {
                const link = document.querySelector('a[data-module="ham-clock"]');
                if (link) link.click();
            }

            // Alt + 3: Switch to Packet Stations
            if (e.altKey && e.key === '3') {
                const link = document.querySelector('a[data-module="packet-radio"]');
                if (link) link.click();
            }

            // Alt + 4: Switch to XTOC Comm
            if (e.altKey && e.key === '4') {
                const link = document.querySelector('a[data-module="comms"]');
                if (link) link.click();
            }

            // Alt + 5: Switch to Mesh
            if (e.altKey && e.key === '5') {
                const link = document.querySelector('a[data-module="mesh"]');
                if (link) link.click();
            }

            // Alt + 6: Switch to Logbook
            if (e.altKey && e.key === '6') {
                const link = document.querySelector('a[data-module="logbook"]');
                if (link) link.click();
            }

            // Alt + 7: Switch to ASCII Art
            if (e.altKey && e.key === '7') {
                const link = document.querySelector('a[data-module="ascii-art"]');
                if (link) link.click();
            }

            // Alt + 8: Switch to Repeater Map
            if (e.altKey && e.key === '8') {
                const link = document.querySelector('a[data-module="repeater-map"]');
                if (link) link.click();
            }

            // Alt + 9: Switch to Map
            if (e.altKey && e.key === '9') {
                const link = document.querySelector('a[data-module="map"]');
                if (link) link.click();
            }

            // Alt + 0: Switch to Help
            if (e.altKey && e.key === '0') {
                const link = document.querySelector('a[data-module="help"]');
                if (link) link.click();
            }
            
            // Ctrl + F: Focus on search box (in Repeater Map)
            if (e.ctrlKey && e.key === 'f' && document.getElementById('locationSearch')) {
                e.preventDefault();
                document.getElementById('locationSearch').focus();
            }
        });
    }
}

// The module will be initialized by main.js after loading
