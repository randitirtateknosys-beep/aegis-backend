const firebaseConfig = {
    apiKey: "AIzaSyDnqlbMx-UMFP3MHG_6tUM50NlPsPzsuzw",
    authDomain: "aegis-kalideres.firebaseapp.com",
    databaseURL: "https://aegis-kalideres-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "aegis-kalideres",
    storageBucket: "aegis-kalideres.firebasestorage.app",
    messagingSenderId: "928229188111",
    appId: "1:928229188111:web:4fc633bc2a1f102350797a"
};

if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const database = firebase.database();

// Helper aman agar tidak pernah error "Cannot set properties of null"
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}
function setHTML(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

// ================= ROLE & PRESENCE SYSTEM =================
let userRole = 'viewer';
let userName = 'Guest';

const passInputEl = document.getElementById('pass-input');
if (passInputEl) {
    passInputEl.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') verifyLogin();
    });
}

window.verifyLogin = function() {
    let uNameEl = document.getElementById('user-name');
    let passEl  = document.getElementById('pass-input');
    let uName   = uNameEl ? uNameEl.value.trim() : "Anonim";
    let pass    = passEl ? passEl.value.toLowerCase().trim() : "";

    if (uName === "") uName = "User";

    if (pass === 'admin' || pass === 'dev2026' || pass === 'aegis2026') {
        userRole = 'developer';
        userName = uName + " (Dev)";
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = '');
        finishLogin();
    } else if (pass === 'viewer' || pass === 'tamu') {
        userRole = 'viewer';
        userName = uName + " (Viewer)";
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = 'none');
        finishLogin();
    } else {
        const errEl = document.getElementById('login-error');
        if (errEl) errEl.style.display = 'block';
    }
};

function finishLogin() {
    const loginScr = document.getElementById('login-screen');
    if (loginScr) loginScr.style.opacity = '0';
    setTimeout(() => {
        if (loginScr) loginScr.style.visibility = 'hidden';
        startBootSequence();
        setupPresence(userName);
    }, 500);
}

function setupPresence(name) {
    let listRef = database.ref('presence');
    let userRef = listRef.push();
    let amOnline = database.ref('.info/connected');

    amOnline.on('value', snapshot => {
        if (snapshot.val()) {
            userRef.onDisconnect().remove();
            userRef.set({ name: name, role: userRole, online: true });
        }
    });

    listRef.on('value', snap => {
        let count = 0;
        let userListHTML = "";
        snap.forEach(child => {
            count++;
            userListHTML += `<div style="padding:3px 0;">🟢 ${child.val().name}</div>`;
        });
        setText('online-count', count);
        setHTML('online-list', userListHTML || "Tidak ada data");
    });
}

// ================= PENGATURAN IP & STATE =================
let ESPCAM_IP  = localStorage.getItem('aegis_cam_ip')  || "http://10.78.168.1";
let ESPMAIN_IP = localStorage.getItem('aegis_main_ip') || "";

let currentCamZoom = 1.0;
let isCamCoverMode = false;
let cloudPanAngle  = 90;
let cloudTiltAngle = 90;
const SERVO_STEP   = 15;

let relayCH1_Pump   = false;
let relayCH2_Alarm  = false;
let relayCH3_Lamp   = false;
let relayCH4_Charge = "SOLAR";
let isAutoATS       = true;
let isSatelliteMode = true;
const ATS_CUTOVER_V = 7.0;
const ATS_RECOVER_V = 8.0;

// ================= CFD FLUID DYNAMICS (ANIMASI AIR) =================
let currentWaterLevel = 0;
let currentStatus = "AMAN";
let fluidOffset = 0;
let fluidColor = 'rgba(14, 165, 233, 0.4)';

function renderFluid() {
    const fCanvas = document.getElementById('fluid-canvas');
    if (!fCanvas) return;
    const fCtx = fCanvas.getContext('2d');
    fCanvas.width = fCanvas.parentElement.clientWidth;
    fCanvas.height = fCanvas.parentElement.clientHeight;
    fCtx.clearRect(0, 0, fCanvas.width, fCanvas.height);
    let fluidHeight = fCanvas.height - (currentWaterLevel / 150) * fCanvas.height;
    if (fluidHeight < 20) fluidHeight = 20;
    if (fluidHeight > fCanvas.height) fluidHeight = fCanvas.height;
    fCtx.beginPath();
    fCtx.moveTo(0, fCanvas.height);
    for (let x = 0; x <= fCanvas.width; x += 5) {
        let y = fluidHeight + Math.sin((x + fluidOffset) * 0.03) * 6 + Math.cos((x + fluidOffset * 1.5) * 0.05) * 4;
        fCtx.lineTo(x, y);
    }
    fCtx.lineTo(fCanvas.width, fCanvas.height);
    fCtx.fillStyle = fluidColor;
    fCtx.fill();
    fluidOffset += 2.5;
    requestAnimationFrame(renderFluid);
}

// ================= SUB-MENU NAV & KONTROL MANUAL =================
window.switchSubMenu = function(menuName) {
    const vOver  = document.getElementById('view-overview');
    const vPower = document.getElementById('view-power');
    const vLogs  = document.getElementById('view-logs');
    if (vOver)  vOver.style.display  = (menuName === 'overview') ? 'grid' : 'none';
    if (vPower) vPower.style.display = (menuName === 'power')    ? 'grid' : 'none';
    if (vLogs)  vLogs.style.display  = (menuName === 'logs')     ? 'block' : 'none';

    const bOver  = document.getElementById('tab-btn-overview');
    const bPower = document.getElementById('tab-btn-power');
    const bLogs  = document.getElementById('tab-btn-logs');
    if (bOver)  bOver.classList.toggle('active', menuName === 'overview');
    if (bPower) bPower.classList.toggle('active', menuName === 'power');
    if (bLogs)  bLogs.classList.toggle('active', menuName === 'logs');

    if (menuName === 'overview' && map) setTimeout(() => { map.invalidateSize(); }, 200);
    if (menuName === 'power' && powerVoltageChart && powerCurrentChart) {
        setTimeout(() => {
            powerVoltageChart.resize(); powerVoltageChart.update();
            powerCurrentChart.resize(); powerCurrentChart.update();
        }, 150);
    }
};

window.setATSMode = function(enableAuto) {
    if (userRole !== 'developer') return;
    isAutoATS = enableAuto;
    let modeStr = isAutoATS ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ ats_mode: modeStr });

    const btnAuto   = document.getElementById('btn-ats-auto');
    const btnManual = document.getElementById('btn-ats-manual');
    if (btnAuto && btnManual) {
        btnAuto.style.background   = isAutoATS ? 'var(--aman)' : 'transparent';
        btnAuto.style.color        = isAutoATS ? '#000' : 'var(--text-main)';
        btnManual.style.background = !isAutoATS ? 'var(--waspada)' : 'transparent';
        btnManual.style.color      = !isAutoATS ? '#000' : 'var(--text-main)';
    }
    setText('ats-mode-text', modeStr);
    setText('top-ats-stat', modeStr);
    addLog('SYS', `Smart ATS diatur ke mode: ${modeStr}`);
};

window.simulateBatteryVoltage = function(simBattV) {
    if (userRole !== 'developer') return;
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let newChg  = (simBattV < ATS_CUTOVER_V) ? "ADAPTOR" : "SOLAR";
    if (isAutoATS) toggleChargeMode(newChg);

    database.ref('sensor/logs').push({
        device_id: "NODE-SIM", timestamp: timeStr, status: currentStatus,
        water_level: currentWaterLevel, distance_cm: Math.max(0, 150 - currentWaterLevel), temperature: 28.5,
        flow_rate_lpm: 0, mass_flow_kgs: 0,
        solar_v: 14.2, solar_i: 310, solar_p: 4402,
        batt_v: simBattV, batt_i: 220, batt_pct: Math.max(0, Math.min(100, Math.round(((simBattV - 6) / 6.8) * 100))),
        lora_rssi: -75, charge_mode: newChg
    });
    addLog('TST', `Simulasi Tegangan Aki: ${simBattV}V -> Mode ${newChg}`);
};

window.moveCam = function(direction) {
    if (userRole !== 'developer') return;
    if (direction === 'left')   cloudPanAngle  = Math.min(180, cloudPanAngle + SERVO_STEP);
    if (direction === 'right')  cloudPanAngle  = Math.max(0, cloudPanAngle - SERVO_STEP);
    if (direction === 'up')     cloudTiltAngle = Math.min(180, cloudTiltAngle + SERVO_STEP);
    if (direction === 'down')   cloudTiltAngle = Math.max(0, cloudTiltAngle - SERVO_STEP);
    if (direction === 'center') { cloudPanAngle = 90; cloudTiltAngle = 90; }

    database.ref('kontrol').update({ pan: cloudPanAngle, tilt: cloudTiltAngle });
    if (ESPMAIN_IP !== "") {
        fetch(`${ESPMAIN_IP}/servo?go=${direction}`).catch(() => {});
    }
    addLog('SRV', `Servo X(Pan): ${cloudPanAngle}° | Y(Tilt): ${cloudTiltAngle}°`);
};

window.toggleRelayTest = function(channel) {
    if (userRole !== 'developer') return;
    if (channel === 1) {
        relayCH1_Pump = !relayCH1_Pump;
        let st = relayCH1_Pump ? "ON" : "OFF";
        database.ref('kontrol').update({ pompa: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=1&val=${st}`).catch(() => {});
        addLog('TST', `Pompa Penguras (CH1): ${st}`);
    } else if (channel === 2) {
        relayCH2_Alarm = !relayCH2_Alarm;
        let st = relayCH2_Alarm ? "ON" : "OFF";
        database.ref('kontrol').update({ alarm: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=2&val=${st}`).catch(() => {});
        addLog('TST', `Alarm Sirine (CH2): ${st}`);
    } else if (channel === 3) {
        relayCH3_Lamp = !relayCH3_Lamp;
        let st = relayCH3_Lamp ? "ON" : "OFF";
        database.ref('kontrol').update({ lampu: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=3&val=${st}`).catch(() => {});
        addLog('TST', `Lampu Orange Waspada (CH3): ${st}`);
    }
};

window.toggleChargeMode = function(forceMode = null) {
    if (userRole !== 'developer') return;
    relayCH4_Charge = forceMode ? forceMode : (relayCH4_Charge === "SOLAR" ? "ADAPTOR" : "SOLAR");
    database.ref('kontrol').update({ charge_mode: relayCH4_Charge });
    if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=4&val=${relayCH4_Charge}`).catch(() => {});
    addLog('PWR', `Sumber Charge (CH4): ${relayCH4_Charge}`);
};

window.toggleFlashLED = function(customAct = 'flash') {
    if (userRole !== 'developer') return;
    fetch(`${ESPCAM_IP}/action?go=${customAct}`)
        .then(r => r.json())
        .then(d => {
            const levels = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
            const txt = levels[d.flash] || 'OFF';
            setText('btn-flash', `💡 FLASH: ${txt}`);
            setText('cam-flash-badge', txt);
            addLog('CAM', `Lampu Flash Kamera: ${txt}`);
        })
        .catch(() => addLog('ERR', `Kamera (${ESPCAM_IP}) belum merespons.`));
};

window.toggleCamFit = function() {
    isCamCoverMode = !isCamCoverMode;
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.objectFit = isCamCoverMode ? 'cover' : 'contain';
    setText('btn-fit', isCamCoverMode ? '🖼️ FIT LAYAR' : '🖼️ FULL SENSOR');
};

window.adjustZoom = function(delta) {
    currentCamZoom = Math.max(0.5, Math.min(3.0, Number((currentCamZoom + delta).toFixed(1))));
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.transform = `scale(${currentCamZoom})`;
    setText('cam-zoom-label', currentCamZoom.toFixed(1) + 'x');
};

window.resetZoom = function() {
    currentCamZoom = 1.0;
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.transform = `scale(1)`;
    setText('cam-zoom-label', '1.0x');
};

// ================= INISIALISASI PETA, GRAFIK & FIREBASE =================
let systemBooted = false;
let globalHistory = [];
var map, waterChart, powerVoltageChart, powerCurrentChart, currentTileLayer;
const KALIDERES_LAT = -6.1044;
const KALIDERES_LNG = 106.7022;

function startBootSequence() {
    const bootScr = document.getElementById('boot-screen');
    if (bootScr) {
        bootScr.style.visibility = 'visible';
        bootScr.style.opacity = '1';
    }

    setTimeout(() => {
        if (bootScr) bootScr.style.opacity = '0';
        setTimeout(() => {
            if (bootScr) bootScr.style.display = 'none';
            const core = document.getElementById('dashboard-core');
            if (core) core.style.display = 'block';
            setTimeout(() => {
                if (core) core.style.opacity = '1';
                systemBooted = true;
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
                setText('cam-ip-label', ESPCAM_IP.replace('http://', '') + ':81');
                initMapsAndCharts();
                startFirebaseListeners();
                renderFluid();
                fetchWeather();
            }, 100);
        }, 500);
    }, 1000);
}

function initMapsAndCharts() {
    map = L.map('map', { zoomControl: true }).setView([KALIDERES_LAT, KALIDERES_LNG], 15);
    currentTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Esri Satellite | A.E.G.I.S'
    }).addTo(map);
    L.marker([KALIDERES_LAT, KALIDERES_LNG]).addTo(map).bindPopup('<b>NODE UTAMA</b><br>Kp. Sawah Mede, Kalideres').openPopup();

    setTimeout(() => { map.invalidateSize(); }, 300);

    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'JetBrains Mono', monospace";

    waterChart = new Chart(document.getElementById('waterChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Elevasi Air (cm)', data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.2)', fill: true, tension: 0.25 },
                { label: 'Prediksi AI (cm)', data: [], borderColor: '#c084fc', borderDash: [5, 5], fill: false, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, suggestedMax: 150 } } }
    });

    powerVoltageChart = new Chart(document.getElementById('powerVoltageChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Solar Panel (V)', data: [], borderColor: '#fbbf24', tension: 0.25 },
                { label: 'Baterai / Aki (V)', data: [], borderColor: '#34d399', tension: 0.25 },
                { label: 'Batas Cutover Adaptor (7.0V)', data: [], borderColor: '#f87171', borderDash: [5, 5], pointRadius: 0 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, suggestedMax: 18 } } }
    });

    powerCurrentChart = new Chart(document.getElementById('powerCurrentChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Arus Solar (mA)', data: [], borderColor: '#fbbf24', tension: 0.25 },
                { label: 'Arus Baterai (mA)', data: [], borderColor: '#34d399', tension: 0.25 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
}

async function fetchWeather() {
    try {
        let res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${KALIDERES_LAT}&longitude=${KALIDERES_LNG}&current_weather=true`);
        let code = (await res.json()).current_weather.weathercode;
        let n = "CERAH", i = "☀️";
        if (code >= 1 && code <= 3) { n = "BERAWAN"; i = "⛅"; }
        else if (code >= 51) { n = code >= 80 ? "BADAI HUJAN" : "HUJAN LOKAL"; i = code >= 80 ? "⛈️" : "🌧️"; }
        setText('teks-cuaca', n);
        setText('ikon-cuaca', i);
    } catch (e) {}
}

function startFirebaseListeners() {
    // 1. Listener Kontrol & Relay 4-Channel
    database.ref('kontrol').on('value', (snap) => {
        let c = snap.val() || {};
        relayCH1_Pump   = (c.pompa === "ON" || c.pompa === "MENYALA");
        relayCH2_Alarm  = (c.alarm === "ON" || c.alarm === "MENYALA");
        relayCH3_Lamp   = (c.lampu === "ON" || c.lampu === "MENYALA");
        relayCH4_Charge = c.charge_mode || "SOLAR";
        isAutoATS       = (c.ats_mode === "AUTO" || c.ats_mode === undefined);

        // Auto-Sync IP Kamera jika ESP32-CAM melapor ke Firebase
        if (c.cam_ip && c.cam_ip !== "") {
            let newCam = `http://${c.cam_ip}`;
            if (ESPCAM_IP !== newCam) {
                ESPCAM_IP = newCam;
                localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
                setText('cam-ip-label', `${c.cam_ip}:81`);
            }
        }

        setText('badge-ch1', relayCH1_Pump ? "ON" : "OFF");
        setText('badge-ch2', relayCH2_Alarm ? "ON" : "OFF");
        setText('badge-ch3', relayCH3_Lamp ? "ON" : "OFF");
        setText('badge-ch4', relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR" : "☀️ SOLAR");

        // Update Widget #8 & #9 di Atas
        const topChg = document.getElementById('top-charge-mode');
        const atsSrc = document.getElementById('ats-curr-source');
        if (topChg) {
            topChg.innerText = relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR DC" : "☀️ SOLAR PANEL";
            topChg.style.color = relayCH4_Charge === "ADAPTOR" ? "#c084fc" : "var(--aman)";
        }
        if (atsSrc) {
            atsSrc.innerText = relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR" : "☀️ SOLAR";
            atsSrc.style.color = relayCH4_Charge === "ADAPTOR" ? "#c084fc" : "var(--primary)";
        }
        setText('top-ats-stat', isAutoATS ? "AUTO" : "MANUAL");
        setText('ats-mode-text', isAutoATS ? "AUTO" : "MANUAL");

        const pBig = document.getElementById('top-pump-big');
        if (pBig) {
            pBig.innerText = relayCH1_Pump ? "🚰 POMPA: AKTIF" : "POMPA: STANDBY";
            pBig.style.color = relayCH1_Pump ? "var(--primary)" : "var(--text-muted)";
        }
        setText('top-alarm-stat', relayCH2_Alarm ? "ON" : "OFF");
        setText('top-lamp-stat', relayCH3_Lamp ? "ON" : "OFF");
    });

    // 2. Listener Data Sensor Telemetri
    database.ref('sensor/logs').limitToLast(20).on('value', (snap) => {
        globalHistory = [];
        snap.forEach(child => globalHistory.push(child.val()));

        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = Number(data.water_level ?? 0);
            currentStatus = data.status || "AMAN";

            if (data.node_ip && data.node_ip !== "" && ESPMAIN_IP !== `http://${data.node_ip}`) {
                ESPMAIN_IP = `http://${data.node_ip}`;
                localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
            }

            setText('teks-air', currentWaterLevel);
            setText('top-jarak', Number(data.distance_cm ?? Math.max(0, 150 - currentWaterLevel)).toFixed(1));
            setText('teks-suhu', data.temperature ?? "0.0");
            setText('teks-flow', Number(data.flow_rate_lpm ?? 0).toFixed(2));
            setText('top-mass', Number(data.mass_flow_kgs ?? 0).toFixed(2));

            let sV = Number(data.solar_v ?? 0).toFixed(2);
            let sI = Number(data.solar_i ?? 0).toFixed(0);
            let sP = Number(data.solar_p ?? (sV * sI)).toFixed(0);
            setText('top-solar-v', sV);
            setText('top-solar-i', sI);
            setText('top-solar-p', sP);

            let numBattV = Number(data.batt_v ?? 0);
            let bV = numBattV.toFixed(2);
            let bI = Number(data.batt_i ?? 0).toFixed(0);
            let bPct = data.batt_pct ?? 92;
            setText('top-batt-v', bV);
            setText('top-batt-i', bI);
            setText('top-batt-pct', `${bPct}%`);
            setText('ats-curr-batt', `${bV} V`);

            // Otomatisasi Smart ATS (< 7.0V -> Pindah ke Adaptor CH4)
            if (isAutoATS && numBattV > 0.1) {
                if (numBattV < ATS_CUTOVER_V && relayCH4_Charge !== "ADAPTOR") {
                    database.ref('kontrol').update({ charge_mode: "ADAPTOR" });
                    addLog('PWR', `⚠️ Aki turun ke ${bV}V (<7.0V)! Smart ATS mengalihkan CH4 ke ADAPTOR.`);
                } else if (numBattV >= ATS_RECOVER_V && relayCH4_Charge === "ADAPTOR") {
                    database.ref('kontrol').update({ charge_mode: "SOLAR" });
                    addLog('PWR', `☀️ Aki pulih ke ${bV}V. Smart ATS kembali ke SOLAR PANEL.`);
                }
            }

            setText('top-lora-rssi', data.lora_rssi ?? -78);
            setText('top-last-sync', data.timestamp || "LIVE");
            setText('top-risiko', Math.min(Math.round((currentWaterLevel / 150) * 100), 100) + "%");

            // Kalkulasi Widget AI Smart Forecast
            let prevWater = globalHistory.length >= 2 ? Number(globalHistory[globalHistory.length - 2].water_level ?? 0) : currentWaterLevel;
            let deltaWater = Number((currentWaterLevel - prevWater).toFixed(1));
            let nextPred = Math.max(0, Number((currentWaterLevel + deltaWater).toFixed(1)));
            setText('top-ai-pred', nextPred.toFixed(1));
            const trEl = document.getElementById('top-ai-trend');
            if (trEl) {
                if (deltaWater > 0) { trEl.innerText = `▲ NAIK (+${deltaWater} cm)`; trEl.style.color = "var(--bahaya)"; }
                else if (deltaWater < 0) { trEl.innerText = `▼ SURUT (${deltaWater} cm)`; trEl.style.color = "var(--aman)"; }
                else { trEl.innerText = `● STABIL (0.0 cm)`; trEl.style.color = "var(--primary)"; }
            }

            let sHtml = '';
            if (currentStatus === 'AMAN') { sHtml = `<span class="badge bg-aman">SECURE</span>`; fluidColor = 'rgba(52, 211, 153, 0.4)'; }
            else if (currentStatus === 'WASPADA') { sHtml = `<span class="badge bg-waspada">WARNING</span>`; fluidColor = 'rgba(251, 191, 36, 0.4)'; }
            else if (currentStatus === 'BAHAYA') { sHtml = `<span class="badge bg-bahaya">CRITICAL EVAC</span>`; fluidColor = 'rgba(248, 113, 113, 0.4)'; }
            setHTML('teks-status', sHtml);

            // Update Grafik
            let labels = globalHistory.map(i => i.timestamp);
            let predArr = new Array(Math.max(0, globalHistory.length - 1)).fill(null);
            predArr.push(currentWaterLevel, nextPred);

            if (waterChart) {
                waterChart.data.labels = [...labels, "T+1"];
                waterChart.data.datasets[0].data = globalHistory.map(i => i.water_level);
                waterChart.data.datasets[1].data = predArr;
                waterChart.update();
            }
            if (powerVoltageChart) {
                powerVoltageChart.data.labels = labels;
                powerVoltageChart.data.datasets[0].data = globalHistory.map(i => Number(i.solar_v ?? 0));
                powerVoltageChart.data.datasets[1].data = globalHistory.map(i => Number(i.batt_v ?? 0));
                powerVoltageChart.data.datasets[2].data = new Array(labels.length).fill(ATS_CUTOVER_V);
                powerVoltageChart.update();
            }
            if (powerCurrentChart) {
                powerCurrentChart.data.labels = labels;
                powerCurrentChart.data.datasets[0].data = globalHistory.map(i => Number(i.solar_i ?? 0));
                powerCurrentChart.data.datasets[1].data = globalHistory.map(i => Number(i.batt_i ?? 0));
                powerCurrentChart.update();
            }

            // Update Tabel Lengkap
            let fullTableHTML = '';
            [...globalHistory].reverse().forEach(item => {
                let ws = item.status === 'BAHAYA' ? 'var(--bahaya)' : (item.status === 'WASPADA' ? 'var(--waspada)' : 'var(--aman)');
                let chg = item.charge_mode || relayCH4_Charge;
                fullTableHTML += `<tr>
                    <td>${item.timestamp}</td>
                    <td><b>${item.water_level} cm</b></td>
                    <td>${Number(item.distance_cm ?? Math.max(0, 150 - (item.water_level ?? 0))).toFixed(1)} cm</td>
                    <td>${Number(item.flow_rate_lpm ?? 0).toFixed(1)} L/m</td>
                    <td>${item.temperature} °C</td>
                    <td style="color:#fbbf24;">${Number(item.solar_v ?? 0).toFixed(2)}V / ${Number(item.solar_i ?? 0).toFixed(0)}mA</td>
                    <td style="color:#34d399;">${Number(item.batt_v ?? 0).toFixed(2)}V / ${item.batt_pct ?? 92}%</td>
                    <td style="color:${chg === 'ADAPTOR' ? '#c084fc' : '#34d399'}; font-weight:bold;">${chg}</td>
                    <td style="color:var(--primary);">${item.lora_rssi ?? -78} dBm</td>
                    <td style="color:${ws}; font-weight:bold;">${item.status}</td>
                </tr>`;
            });
            setHTML('fullTableBody', fullTableHTML);
        }
    });
}

// Terminal Input Listener
const cmdInputEl = document.getElementById('cmd-input');
if (cmdInputEl) {
    cmdInputEl.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && userRole === 'developer') {
            let cmd = this.value.toLowerCase().trim();
            this.value = '';
            addLog('CMD', `> ${cmd}`);
            if (cmd === 'clear') setHTML('terminalLog', '');
            else if (cmd === 'pump on') { relayCH1_Pump = false; toggleRelayTest(1); }
            else if (cmd === 'pump off') { relayCH1_Pump = true; toggleRelayTest(1); }
            else if (cmd === 'alarm on') { relayCH2_Alarm = false; toggleRelayTest(2); }
            else if (cmd === 'alarm off') { relayCH2_Alarm = true; toggleRelayTest(2); }
            else if (cmd === 'mode solar') toggleChargeMode('SOLAR');
            else if (cmd === 'mode adaptor') toggleChargeMode('ADAPTOR');
            else if (cmd.startsWith('setcam ')) {
                let ip = cmd.replace('setcam ', '').trim();
                ESPCAM_IP = `http://${ip}`;
                localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
                setText('cam-ip-label', `${ip}:81`);
                addLog('CAM', `IP Kamera diubah ke ${ESPCAM_IP}`);
            }
        }
    });
}

window.toggleTheme = function() { document.body.classList.toggle('light-mode'); };
window.toggleDeck = function() { document.getElementById('control-deck').classList.toggle('open'); };
window.updateSimValue = function(val) { setText('sim-val', val); };
window.pushSimData = function(val) {
    if (userRole !== 'developer') return;
    let num = Number(val);
    let stat = num >= 100 ? "BAHAYA" : (num >= 70 ? "WASPADA" : "AMAN");
    database.ref('sensor/logs').push({
        device_id: "NODE-SIM-1", timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        status: stat, water_level: num, distance_cm: Math.max(0, 150 - num), temperature: 28.5,
        solar_v: 14.2, solar_i: 310, batt_v: 12.4, batt_i: 180, batt_pct: 92, lora_rssi: -75
    });
};
window.changeCamIPPrompt = function() {
    if (userRole !== 'developer') return;
    let ip = prompt("Masukkan IP ESP32-CAM Anda (contoh: 10.78.168.1):", ESPCAM_IP.replace('http://', ''));
    if (ip && ip.trim() !== "") {
        let clean = ip.replace('http://', '').replace(':81/stream', '').trim();
        ESPCAM_IP = `http://${clean}`;
        localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        const camEl = document.getElementById('espcam-stream');
        if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
        setText('cam-ip-label', `${clean}:81`);
    }
};
window.toggleMapLayer = function() {
    if (!map) return;
    isSatelliteMode = !isSatelliteMode;
    map.removeLayer(currentTileLayer);
    currentTileLayer = L.tileLayer(
        isSatelliteMode
            ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
            : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    ).addTo(map);
    setText('btn-map-mode', isSatelliteMode ? '🗺️ JALAN' : '🛰️ SATELIT');
};
window.centerMap = function() { if (map) map.setView([KALIDERES_LAT, KALIDERES_LNG], 15); };
window.toggleFullscreenCam = function() {
    const box = document.getElementById('cctv-feed');
    if (box && !document.fullscreenElement) box.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen();
};
window.downloadCSV = function() {
    if (!globalHistory.length) return;
    let csv = "Waktu,Water Level (cm),Distance (cm),Flow (L/m),Temp (C),Solar (V),Solar (mA),Batt (V),Batt (%),Charge Mode,LoRa (dBm),Status\n";
    globalHistory.forEach(r => {
        csv += `${r.timestamp},${r.water_level},${r.distance_cm ?? 0},${r.flow_rate_lpm ?? 0},${r.temperature},${r.solar_v ?? 0},${r.solar_i ?? 0},${r.batt_v ?? 0},${r.batt_pct ?? 92},${r.charge_mode ?? 'SOLAR'},${r.lora_rssi ?? -78},${r.status}\n`;
    });
    let a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'aegis_smart_telemetry.csv';
    a.click();
};
window.generatePDF = function() { html2pdf().from(document.getElementById('report-area')).save('AEGIS_Smart_Report.pdf'); };
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog');
    if (term) {
        term.innerHTML += `<div class="terminal-line"><span style="color:var(--text-muted);">${new Date().toLocaleTimeString('id-ID', { hour12: false })}</span> <b>[${tipe}]</b> ${pesan}</div>`;
        term.scrollTop = term.scrollHeight;
    }
}

setInterval(() => {
    const now = new Date();
    setText('teks-jam', now.toLocaleTimeString('id-ID', { hour12: false }));
    setText('teks-tanggal', now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase());
}, 1000);
