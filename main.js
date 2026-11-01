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

// Helper anti-null agar UI selalu aman
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}
function setHTML(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

// ================= PENGATURAN ROLE KEAMANAN & PENGGUNA ONLINE =================
let userRole = 'developer';
let userName = 'Operator';

function setupPresence(name, role) {
    let listRef = database.ref('presence');
    let userRef = listRef.push();
    let amOnline = database.ref('.info/connected');

    amOnline.on('value', snapshot => {
        if (snapshot.val()) {
            userRef.onDisconnect().remove();
            userRef.set({
                name: name,
                role: role,
                login_time: new Date().toLocaleTimeString('id-ID', { hour12: false })
            });
        }
    });

    listRef.on('value', snap => {
        let count = 0;
        let html = `<div style="font-weight:bold; color:var(--primary); border-bottom:1px solid rgba(56,189,248,0.2); padding-bottom:4px; margin-bottom:6px;">PENGGUNA AKTIF:</div>`;
        snap.forEach(child => {
            count++;
            let u = child.val();
            let badgeColor = u.role === 'developer' ? '#10b981' : '#38bdf8';
            let roleLabel  = u.role === 'developer' ? 'DEV' : 'VIEW';
            html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:3px 0;">
                <span>🟢 ${u.name}</span>
                <span style="font-size:9px; padding:1px 5px; border-radius:4px; border:1px solid ${badgeColor}; color:${badgeColor};">${roleLabel}</span>
            </div>`;
        });
        setText('online-count', count);
        setHTML('online-list', html);
    });
}

// ================= PENGATURAN IP KAMERA & IP ESP32 UTAMA =================
let ESPCAM_IP  = localStorage.getItem('aegis_cam_ip')  || "http://10.78.168.1";
let ESPMAIN_IP = localStorage.getItem('aegis_main_ip') || "";

let currentCamZoom = 1.0;
let isCamCoverMode = false;
let cloudPanAngle  = 90;
let cloudTiltAngle = 90;
const SERVO_STEP   = 15;

// Status 4-Channel Relay & Smart ATS (< 7.0V -> Adaptor)
let relayCH1_Pump   = false;
let relayCH2_Alarm  = false;
let relayCH3_Lamp   = false;
let relayCH4_Charge = "SOLAR";
let isAutoATS       = true;
const ATS_CUTOVER_V = 7.0;
const ATS_RECOVER_V = 8.0;
let testAlarmLoop   = null;

let currentWaterLevel = 0; let currentStatus = "AMAN"; let previousStatus = null;
let isPumpActive = false; let isEvacActive = false; let alarmPlaying = false;
let systemBooted = false; let globalHistory = []; window.lastTimestamp = null;
let iconAman, iconWaspada, iconBahaya;
var map, waterChart, powerVoltageChart, powerCurrentChart, routingControl, ctx;

// ================= FUNGSI PINDAH SUB-MENU (OVERVIEW / POWER / LOGS) =================
window.switchSubMenu = function(menuName) {
    document.getElementById('view-overview').style.display = (menuName === 'overview') ? 'grid' : 'none';
    document.getElementById('view-power').style.display    = (menuName === 'power')    ? 'grid' : 'none';
    document.getElementById('view-logs').style.display     = (menuName === 'logs')     ? 'block' : 'none';

    document.getElementById('tab-btn-overview').classList.toggle('active', menuName === 'overview');
    document.getElementById('tab-btn-power').classList.toggle('active', menuName === 'power');
    document.getElementById('tab-btn-logs').classList.toggle('active', menuName === 'logs');

    if (menuName === 'overview' && map) {
        setTimeout(() => { map.invalidateSize(); }, 200);
    }
    if (menuName === 'power' && powerVoltageChart && powerCurrentChart) {
        setTimeout(() => {
            powerVoltageChart.resize(); powerVoltageChart.update();
            powerCurrentChart.resize(); powerCurrentChart.update();
        }, 150);
    }
};

// ================= FUNGSI OTOMATISASI SMART ATS (< 7V -> ADAPTOR) =================
window.setATSMode = function(enableAuto) {
    if (userRole !== 'developer') return;
    isAutoATS = enableAuto;
    let modeStr = isAutoATS ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ ats_mode: modeStr });

    const btnAuto   = document.getElementById('btn-ats-auto');
    const btnManual = document.getElementById('btn-ats-manual');
    const badgeATS  = document.getElementById('ats-status-badge');
    const topATS    = document.getElementById('top-ats-stat');

    if (btnAuto && btnManual) {
        btnAuto.style.background   = isAutoATS ? 'var(--aman)' : 'transparent';
        btnAuto.style.color        = isAutoATS ? '#000' : 'var(--primary)';
        btnManual.style.background = !isAutoATS ? 'var(--waspada)' : 'transparent';
        btnManual.style.color      = !isAutoATS ? '#000' : 'var(--primary)';
    }
    if (badgeATS) {
        badgeATS.innerText = isAutoATS ? 'AUTO CUTOVER (<7V)' : 'MANUAL OVERRIDE';
        badgeATS.className = isAutoATS ? 'badge bg-aman' : 'badge bg-waspada';
    }
    if (topATS) {
        topATS.innerText   = modeStr;
        topATS.style.color = isAutoATS ? 'var(--aman)' : 'var(--waspada)';
    }
    addLog('PWR', `🤖 Smart ATS diatur ke mode: ${modeStr}`);
};

window.simulateBatteryVoltage = function(simBattV) {
    if (userRole !== 'developer') return;
    let lastLog = globalHistory.length > 0 ? globalHistory[globalHistory.length - 1] : {};
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let sV      = Number(lastLog.solar_v ?? 14.2);
    let sI      = Number(lastLog.solar_i ?? 320);
    let bI      = simBattV < 7.0 ? 450 : 210;
    let bPct    = Math.max(0, Math.min(100, Math.round(((simBattV - 6.0) / (12.8 - 6.0)) * 100)));
    let newChg  = (simBattV < ATS_CUTOVER_V) ? "ADAPTOR" : "SOLAR";

    if (isAutoATS) {
        toggleChargeMode(newChg);
    }

    database.ref('sensor/logs').push({
        device_id: "NODE-KALIDERES-01",
        timestamp: timeStr,
        status: currentStatus,
        water_level: currentWaterLevel,
        distance_cm: Math.max(0, 150 - currentWaterLevel),
        temperature: Number(lastLog.temperature ?? 28.5),
        flow_rate_lpm: Number(lastLog.flow_rate_lpm ?? 0),
        mass_flow_kgs: Number(lastLog.mass_flow_kgs ?? 0),
        solar_v: sV,
        solar_i: sI,
        solar_p: Math.round(sV * sI),
        batt_v: simBattV,
        batt_i: bI,
        batt_p: Math.round(simBattV * bI),
        batt_pct: bPct,
        lora_rssi: Number(lastLog.lora_rssi ?? -75),
        charge_mode: newChg
    });
    addLog('PWR', `🧪 Simulasi Tegangan Aki: ${simBattV.toFixed(2)}V -> Mode Charge: ${newChg}`);
};

window.moveCam = function(direction) {
    if (userRole !== 'developer') return;
    if (direction === 'left')   cloudPanAngle  = Math.min(180, cloudPanAngle + SERVO_STEP);
    if (direction === 'right')  cloudPanAngle  = Math.max(0, cloudPanAngle - SERVO_STEP);
    if (direction === 'up')     cloudTiltAngle = Math.min(180, cloudTiltAngle + SERVO_STEP);
    if (direction === 'down')   cloudTiltAngle = Math.max(0, cloudTiltAngle - SERVO_STEP);
    if (direction === 'center') { cloudPanAngle = 90; cloudTiltAngle = 90; }

    database.ref('kontrol').update({
        pan: cloudPanAngle,
        tilt: cloudTiltAngle
    });

    if (ESPMAIN_IP !== "") {
        fetch(`${ESPMAIN_IP}/servo?go=${direction}`)
            .then(res => res.json())
            .then(data => {
                cloudPanAngle  = data.pan;
                cloudTiltAngle = data.tilt;
                addLog('SRV', `Servo ESP32 -> X(Pan):${data.pan}° | Y(Tilt):${data.tilt}°`);
            })
            .catch(() => {
                addLog('SRV', `Cloud Servo -> X(Pan):${cloudPanAngle}° | Y(Tilt):${cloudTiltAngle}°`);
            });
    } else {
        addLog('SRV', `Cloud Servo -> X(Pan):${cloudPanAngle}° | Y(Tilt):${cloudTiltAngle}°`);
    }
};

// ================= FUNGSI KONTROL & TEST 4-CHANNEL RELAY =================
function updateRelayButtonsUI() {
    const btn1 = document.getElementById('btn-relay-ch1');
    const bdg1 = document.getElementById('badge-ch1');
    if (btn1 && bdg1) {
        bdg1.innerText = relayCH1_Pump ? "ON" : "OFF";
        btn1.style.background = relayCH1_Pump ? "var(--primary)" : "transparent";
        btn1.style.color      = relayCH1_Pump ? "#000" : "var(--primary)";
    }
    setText('top-pump-stat', relayCH1_Pump ? "ON" : "OFF");

    const pBig = document.getElementById('top-pump-big');
    if (pBig) {
        pBig.innerText   = relayCH1_Pump ? "🚰 POMPA: AKTIF" : "POMPA: STANDBY";
        pBig.style.color = relayCH1_Pump ? "var(--primary)" : "var(--text-muted)";
    }

    const btn2 = document.getElementById('btn-relay-ch2');
    const bdg2 = document.getElementById('badge-ch2');
    if (btn2 && bdg2) {
        bdg2.innerText = relayCH2_Alarm ? "ON" : "OFF";
        btn2.style.background = relayCH2_Alarm ? "var(--bahaya)" : "transparent";
        btn2.style.color      = relayCH2_Alarm ? "#fff" : "var(--bahaya)";
    }
    const topAlarm = document.getElementById('top-alarm-stat');
    if (topAlarm) {
        topAlarm.innerText   = relayCH2_Alarm ? "ON" : "OFF";
        topAlarm.style.color = relayCH2_Alarm ? "var(--bahaya)" : "var(--text-muted)";
    }

    const btn3 = document.getElementById('btn-relay-ch3');
    const bdg3 = document.getElementById('badge-ch3');
    if (btn3 && bdg3) {
        bdg3.innerText = relayCH3_Lamp ? "ON" : "OFF";
        btn3.style.background = relayCH3_Lamp ? "var(--waspada)" : "transparent";
        btn3.style.color      = relayCH3_Lamp ? "#000" : "var(--waspada)";
    }
    const topLamp = document.getElementById('top-lamp-stat');
    if (topLamp) {
        topLamp.innerText   = relayCH3_Lamp ? "ON" : "OFF";
        topLamp.style.color = relayCH3_Lamp ? "var(--waspada)" : "var(--text-muted)";
    }

    const btn4 = document.getElementById('btn-relay-ch4');
    const bdg4 = document.getElementById('badge-ch4');
    const topChg = document.getElementById('top-charge-mode');
    const atsSrc = document.getElementById('ats-curr-source');
    if (btn4 && bdg4) {
        if (relayCH4_Charge === "ADAPTOR") {
            bdg4.innerText = "🔌 ADAPTOR";
            btn4.style.borderColor = "#c084fc";
            btn4.style.color       = "#fff";
            btn4.style.background  = "rgba(192, 132, 252, 0.35)";
            if (topChg) { topChg.innerText = "🔌 ADAPTOR DC"; topChg.style.color = "#c084fc"; }
            if (atsSrc) { atsSrc.innerText = "🔌 ADAPTOR"; atsSrc.style.color = "#c084fc"; }
        } else {
            bdg4.innerText = "☀️ SOLAR";
            btn4.style.borderColor = "var(--aman)";
            btn4.style.color       = "var(--aman)";
            btn4.style.background  = "transparent";
            if (topChg) { topChg.innerText = "☀️ SOLAR PANEL"; topChg.style.color = "var(--aman)"; }
            if (atsSrc) { atsSrc.innerText = "☀️ SOLAR"; atsSrc.style.color = "var(--aman)"; }
        }
    }
}

window.toggleRelayTest = function(channel) {
    if (userRole !== 'developer') return;
    if (channel === 1) {
        relayCH1_Pump = !relayCH1_Pump;
        let st = relayCH1_Pump ? "ON" : "OFF";
        database.ref('kontrol').update({ pompa: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=1&val=${st}`).catch(() => {});
        addLog('TST', `🚰 TEST POMPA (CH1): ${st}`);
    } else if (channel === 2) {
        relayCH2_Alarm = !relayCH2_Alarm;
        let st = relayCH2_Alarm ? "ON" : "OFF";
        database.ref('kontrol').update({ alarm: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=2&val=${st}`).catch(() => {});
        
        if (relayCH2_Alarm) {
            document.body.classList.add('danger-mode');
            playBeep(2000, 'square', 0.5, 0.15);
            let msg = new SpeechSynthesisUtterance("Pengujian sistem alarm sirine diaktifkan.");
            msg.lang = 'id-ID'; window.speechSynthesis.speak(msg);
            if (!testAlarmLoop) {
                testAlarmLoop = setInterval(() => { playBeep(1800, 'sawtooth', 0.3, 0.1); }, 1000);
            }
        } else {
            if (currentStatus !== 'BAHAYA') document.body.classList.remove('danger-mode');
            if (testAlarmLoop) { clearInterval(testAlarmLoop); testAlarmLoop = null; }
        }
        addLog('TST', `🚨 TEST ALARM SIRINE (CH2): ${st}`);
    } else if (channel === 3) {
        relayCH3_Lamp = !relayCH3_Lamp;
        let st = relayCH3_Lamp ? "ON" : "OFF";
        database.ref('kontrol').update({ lampu: st });
        if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=3&val=${st}`).catch(() => {});
        addLog('TST', `🟠 TEST LAMPU ORANGE WASPADA (CH3): ${st}`);
    }
    updateRelayButtonsUI();
};

window.toggleChargeMode = function(forceMode = null) {
    if (userRole !== 'developer' && !forceMode) return;
    if (forceMode) {
        relayCH4_Charge = forceMode;
    } else {
        relayCH4_Charge = (relayCH4_Charge === "SOLAR") ? "ADAPTOR" : "SOLAR";
    }
    database.ref('kontrol').update({ charge_mode: relayCH4_Charge });
    if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=4&val=${relayCH4_Charge}`).catch(() => {});
    addLog('PWR', `⚡ CH4 Sumber Pengisian diatur ke: MODE ${relayCH4_Charge}`);
    updateRelayButtonsUI();
};

window.toggleFlashLED = function(customAction = 'flash') {
    if (userRole !== 'developer') return;
    fetch(`${ESPCAM_IP}/action?go=${customAction}`)
        .then(res => res.json())
        .then(data => {
            const levels = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
            const lvlText = levels[data.flash] || 'OFF';
            const btnFlash = document.getElementById('btn-flash');
            if (btnFlash) {
                btnFlash.innerText = `💡 FLASH: ${lvlText}`;
                btnFlash.style.background = data.flash > 0 ? '#facc15' : 'transparent';
                btnFlash.style.color = data.flash > 0 ? '#000' : '#facc15';
            }
            setText('cam-flash-badge', lvlText);
            addLog('CAM', `Lampu Flash ESP32-CAM diatur ke: ${lvlText}`);
        })
        .catch(() => addLog('ERR', `Gagal mengubah Lampu Flash di ${ESPCAM_IP}`));
};

window.adjustZoom = function(delta) {
    currentCamZoom = Math.min(3.0, Math.max(0.5, Number((currentCamZoom + delta).toFixed(1))));
    applyCamTransform();
};

window.resetZoom = function() {
    currentCamZoom = 1.0;
    applyCamTransform();
    fetch(`${ESPCAM_IP}/action?go=fov_wide`).catch(() => {});
};

window.toggleCamFit = function() {
    isCamCoverMode = !isCamCoverMode;
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.objectFit = isCamCoverMode ? 'cover' : 'contain';
    setText('btn-fit', isCamCoverMode ? '🖼️ FIT LAYAR' : '🖼️ FULL SENSOR');
};

function applyCamTransform() {
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.transform = `scale(${currentCamZoom})`;
    setText('cam-zoom-label', `${currentCamZoom.toFixed(1)}x`);
}

window.changeCamIPPrompt = function() {
    if (userRole !== 'developer') return;
    let currentIP = ESPCAM_IP.replace('http://', '');
    let inputIP = prompt("Masukkan IP ESP32-CAM Anda (contoh: 10.78.168.1):", currentIP);
    if (inputIP && inputIP.trim() !== "") {
        let cleanIP = inputIP.replace('http://', '').replace(':81/stream', '').trim();
        ESPCAM_IP = `http://${cleanIP}`;
        localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        const camEl = document.getElementById('espcam-stream');
        if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
        setText('cam-ip-label', `${cleanIP}:81`);
        addLog('CAM', `Streaming kamera diarahkan ke ${ESPCAM_IP}:81/stream`);
    }
};

window.toggleFullscreenCam = function() {
    const camBox = document.getElementById('cctv-feed');
    if (camBox && !document.fullscreenElement) {
        camBox.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) {
        document.exitFullscreen();
    }
};

// ==========================================
// CFD FLUID DYNAMICS (ANIMASI GELOMBANG AIR)
// ==========================================
let fluidOffset = 0; let fluidColor = 'rgba(56, 189, 248, 0.4)';
function renderFluid() {
    const fCanvas = document.getElementById('fluid-canvas'); if (!fCanvas) return;
    const fCtx = fCanvas.getContext('2d');
    fCanvas.width = fCanvas.parentElement.clientWidth; fCanvas.height = fCanvas.parentElement.clientHeight;
    fCtx.clearRect(0, 0, fCanvas.width, fCanvas.height);
    let fluidHeight = fCanvas.height - (currentWaterLevel / 150) * fCanvas.height;
    if (fluidHeight < 20) fluidHeight = 20; if (fluidHeight > fCanvas.height) fluidHeight = fCanvas.height;
    fCtx.beginPath(); fCtx.moveTo(0, fCanvas.height);
    for (let x = 0; x <= fCanvas.width; x += 5) {
        let y = fluidHeight + Math.sin((x + fluidOffset) * 0.03) * 6 + Math.cos((x + fluidOffset * 1.5) * 0.05) * 4;
        fCtx.lineTo(x, y);
    }
    fCtx.lineTo(fCanvas.width, fCanvas.height); fCtx.fillStyle = fluidColor; fCtx.fill();
    fluidOffset += 2.5; requestAnimationFrame(renderFluid);
}

// ==========================================
// AUDIO SYNTHESIZER & PANEL SIMULASI
// ==========================================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq = 800, type = 'sine', duration = 0.1, vol = 0.05) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let osc1 = audioCtx.createOscillator(); let osc2 = audioCtx.createOscillator(); let gain = audioCtx.createGain();
    osc1.type = type; osc1.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc2.type = 'triangle'; osc2.frequency.setValueAtTime(freq * 1.5, audioCtx.currentTime); 
    gain.gain.setValueAtTime(vol, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
    osc1.connect(gain); osc2.connect(gain); gain.connect(audioCtx.destination);
    osc1.start(); osc2.start(); osc1.stop(audioCtx.currentTime + duration); osc2.stop(audioCtx.currentTime + duration);
}
document.querySelectorAll('.btn-sfx').forEach(btn => { btn.addEventListener('click', () => playBeep(1200, 'square', 0.08)); });

window.toggleDeck = function() {
    if (userRole !== 'developer') return;
    document.getElementById('control-deck').classList.toggle('open');
    playBeep(1200, 'square', 0.1);
};
window.updateSimValue = function(val) {
    setText('sim-val', val);
    playBeep(400 + parseInt(val) * 5, 'sine', 0.05, 0.01);
};
window.pushSimData = function(val) {
    if (userRole !== 'developer') return;
    let numVal = parseInt(val);
    let stat = numVal >= 100 ? "BAHAYA" : (numVal >= 70 ? "WASPADA" : "AMAN");
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let lastLog = globalHistory.length > 0 ? globalHistory[globalHistory.length - 1] : {};

    database.ref('sensor/logs').push({
        device_id: "NODE-SIM-1",
        status: stat,
        temperature: Number((28 + Math.random() * 2).toFixed(1)),
        timestamp: timeStr,
        water_level: numVal,
        distance_cm: Math.max(0, 150 - numVal),
        flow_rate_lpm: stat === "BAHAYA" ? 12.5 : 0.0,
        mass_flow_kgs: stat === "BAHAYA" ? 0.21 : 0.0,
        solar_v: Number(lastLog.solar_v ?? 14.2),
        solar_i: Number(lastLog.solar_i ?? 310),
        batt_v: Number(lastLog.batt_v ?? 12.4),
        batt_i: Number(lastLog.batt_i ?? 190),
        batt_pct: Number(lastLog.batt_pct ?? 92),
        lora_rssi: Number(lastLog.lora_rssi ?? -76),
        charge_mode: relayCH4_Charge
    });
    addLog('SYS', `🧪 SIMULASI AKTIF: Injeksi Tinggi Air ${numVal} cm (${stat}) ke Cloud!`);
};

// ==========================================
// YOLOv10n AI OBJECT DETECTION SIMULATION
// ==========================================
let yoloActive = false; let yoloInterval;
window.toggleYolo = function() {
    yoloActive = !yoloActive;
    const yCanvas = document.getElementById('yolo-canvas');
    if (yoloActive) {
        yCanvas.style.display = 'block';
        addLog('AI', 'MENGAKTIFKAN YOLOv10n OBJECT DETECTION...');
        playBeep(1500, 'square', 0.2);
        yoloInterval = setInterval(() => {
            yCanvas.innerHTML = '';
            let numBoxes = Math.floor(Math.random() * 2) + 1;
            for (let i = 0; i < numBoxes; i++) {
                let w = 60 + Math.random() * 70; let h = 50 + Math.random() * 60;
                let x = Math.random() * (yCanvas.clientWidth - w); let y = Math.random() * (yCanvas.clientHeight - h);
                let conf = (85 + Math.random() * 14).toFixed(1);
                let classes = ['WATER_SURFACE', 'DEBRIS_DETECTED', 'DRAIN_FLOW'];
                let cls = classes[Math.floor(Math.random() * classes.length)];
                yCanvas.innerHTML += `<div class="yolo-bbox" style="width:${w}px; height:${h}px; left:${x}px; top:${y}px;"><div class="yolo-label">${cls} ${conf}%</div></div>`;
            }
        }, 1200);
    } else {
        yCanvas.style.display = 'none';
        clearInterval(yoloInterval);
        yCanvas.innerHTML = '';
        addLog('AI', 'YOLOv10n DINONAKTIFKAN.');
    }
};
function simulatePCB() {
    setInterval(() => {
        const rx = document.getElementById('led-rx');
        const tx = document.getElementById('led-tx');
        if (rx) rx.classList.toggle('active');
        if (tx && Math.random() > 0.5) tx.classList.toggle('active');
    }, 180);
}

// ==========================================
// LOGIN MULTI-ROLE & BOOT SEQUENCE
// ==========================================
document.getElementById('pass-input').addEventListener('keypress', function(e) { if (e.key === 'Enter') verifyLogin(); });

window.verifyLogin = function() {
    let rawName = document.getElementById('user-name').value.trim();
    let pass    = document.getElementById('pass-input').value.toLowerCase().trim();
    if (rawName === "") rawName = "User";

    if (pass === 'admin' || pass === 'dev2026' || pass === 'aegis2026') {
        userRole = 'developer';
        userName = rawName;
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = '');
        const rBadge = document.getElementById('role-badge');
        if (rBadge) { rBadge.innerText = 'DEVELOPER'; rBadge.className = 'badge bg-aman'; }
    } else if (pass === 'tamu' || pass === 'viewer') {
        userRole = 'viewer';
        userName = rawName;
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = 'none');
        const rBadge = document.getElementById('role-badge');
        if (rBadge) { rBadge.innerText = 'VIEWER'; rBadge.className = 'badge bg-waspada'; }
    } else {
        playBeep(200, 'sawtooth', 0.3, 0.1);
        document.getElementById('login-error').style.display = 'block';
        document.getElementById('pass-input').value = '';
        return;
    }

    playBeep(1000, 'square', 0.2, 0.1);
    document.getElementById('login-screen').style.opacity = '0';
    setTimeout(() => {
        document.getElementById('login-screen').style.visibility = 'hidden';
        setupPresence(userName, userRole);
        startBootSequence();
    }, 600);
};

function startBootSequence() {
    document.getElementById('boot-screen').style.visibility = 'visible';
    document.getElementById('boot-screen').style.opacity = '1';
    const bootLog = document.getElementById('boot-log');
    const messages = [
        `> OTORISASI BERHASIL: ${userName.toUpperCase()} [${userRole.toUpperCase()}]`,
        "> MENGHUBUNGKAN KE FIREBASE REALTIME CLOUD...",
        "> MENGKALIBRASI DUAL INA219, SMART ATS (<7V) & VOICE AI...",
        "> MENGAKTIFKAN STREAMING ESP32-CAM & GEOSPATIAL MAP...",
        "> SISTEM A.E.G.I.S SMART CLOUD SIAP."
    ];
    let i = 0;
    let bootInterval = setInterval(() => {
        if (i < messages.length) {
            bootLog.innerHTML += messages[i] + "<br>";
            playBeep(450 + (i * 100), 'sine', 0.05, 0.02);
            i++;
        } else {
            clearInterval(bootInterval);
            setTimeout(() => {
                playBeep(1400, 'sine', 0.25, 0.08);
                document.getElementById('boot-screen').style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('boot-screen').style.visibility = 'hidden';
                    document.getElementById('dashboard-core').style.display = 'block';
                    setTimeout(() => {
                        document.getElementById('dashboard-core').style.opacity = '1';
                        systemBooted = true;
                        const camImg = document.getElementById('espcam-stream');
                        if (camImg) camImg.src = `${ESPCAM_IP}:81/stream`;
                        setText('cam-ip-label', `${ESPCAM_IP.replace('http://', '')}:81`);
                        initMapsAndCharts();
                        startFirebaseListeners();
                        renderFluid();
                        simulatePCB();
                    }, 100);
                }, 600);
            }, 350);
        }
    }, 300);
}

// ==========================================
// REAL MAP & CHARTS ENGINE
// ==========================================
let isLightMode = false;
let isSatelliteMode = true;
var mapTilesSatellite = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
var mapTilesStreet    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
var currentTileLayer;

let markerUtama, markerHulu, markerHilir, markerPosko;
const KALIDERES_LAT = -6.1044; const KALIDERES_LNG = 106.7022; 
const POSKO_LAT = -6.1015; const POSKO_LNG = 106.7085; 
const HULU_LAT = -6.1150; const HULU_LNG = 106.6950; const HILIR_LAT = -6.0950; const HILIR_LNG = 106.7150;

window.toggleMapLayer = function() {
    if (!map) return;
    isSatelliteMode = !isSatelliteMode;
    map.removeLayer(currentTileLayer);
    const btnMap = document.getElementById('btn-map-mode');
    if (isSatelliteMode) {
        currentTileLayer = L.tileLayer(mapTilesSatellite, { maxZoom: 19, attribution: 'Esri Satellite | A.E.G.I.S' }).addTo(map);
        if (btnMap) btnMap.innerHTML = '🗺️ MODE JALAN';
        addLog('MAP', 'Beralih ke Citra Satelit Real-View.');
    } else {
        currentTileLayer = L.tileLayer(mapTilesStreet, { maxZoom: 19, attribution: 'OpenStreetMap | A.E.G.I.S' }).addTo(map);
        if (btnMap) btnMap.innerHTML = '🛰️ MODE SATELIT';
        addLog('MAP', 'Beralih ke Peta Jalan OpenStreetMap.');
    }
};

window.centerMap = function() {
    if (map) {
        map.setView([KALIDERES_LAT, KALIDERES_LNG], 16);
        addLog('MAP', 'Fokus kamera peta dikembalikan ke Node Utama Kp. Sawah Mede.');
    }
};

window.toggleTheme = function() {
    isLightMode = !isLightMode;
    document.body.classList.toggle('light-mode');
    let btn = document.getElementById('btn-theme');
    if (isLightMode) {
        btn.innerHTML = '🌙 GELAP';
        Chart.defaults.color = '#64748b';
        Chart.defaults.borderColor = 'rgba(0,0,0,0.1)';
    } else {
        btn.innerHTML = '🌞 TERANG';
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(56,189,248,0.1)';
    }
    if (waterChart) waterChart.update();
    if (powerVoltageChart) powerVoltageChart.update();
    if (powerCurrentChart) powerCurrentChart.update();
};

// ==========================================
// AI VOICE ASSISTANT (NLP BAHASA INDONESIA)
// ==========================================
let aiListening = false; let aiTimeout;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

if (recognition) {
    recognition.lang = 'id-ID';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = function(e) {
        clearTimeout(aiTimeout);
        const perintah = e.results[e.results.length - 1][0].transcript.toLowerCase();
        addLog('AI', `Suara Masuk: "${perintah}"`);
        let jawaban = "Perintah suara belum dikenali. Silakan tanyakan status air, cuaca, pompa, suhu, solar, atau baterai.";
        if (perintah.includes('air') || perintah.includes('banjir')) {
            jawaban = `Tinggi air saat ini ${currentWaterLevel} sentimeter dengan status lingkungan ${currentStatus}.`;
        } else if (perintah.includes('cuaca')) {
            jawaban = `Pemindaian cuaca di Kalideres saat ini menunjukkan kondisi ${document.getElementById('teks-cuaca').innerText}.`;
        } else if (perintah.includes('pompa') || perintah.includes('flow')) {
            jawaban = `Pompa penguras berstatus ${relayCH1_Pump ? 'menyala' : 'siaga'} dengan debit aliran ${document.getElementById('yf-flowrate').innerText} liter per menit.`;
        } else if (perintah.includes('lampu') || perintah.includes('flash')) {
            if (userRole === 'developer') toggleFlashLED();
            jawaban = "Mengubah status lampu flash kamera pemantau.";
        } else if (perintah.includes('suhu')) {
            jawaban = `Suhu lingkungan saat ini berada di angka ${document.getElementById('teks-suhu').innerText} derajat celcius.`;
        } else if (perintah.includes('solar')) {
            jawaban = `Tegangan panel surya saat ini ${document.getElementById('top-solar-v').innerText} volt dengan arus ${document.getElementById('top-solar-i').innerText} miliampere.`;
        } else if (perintah.includes('baterai') || perintah.includes('aki')) {
            jawaban = `Status daya baterai ${document.getElementById('txt-batt').innerText}. Sumber pengisian aktif saat ini menggunakan ${relayCH4_Charge}.`;
        } else if (perintah.includes('sinyal') || perintah.includes('lora')) {
            jawaban = `Kekuatan sinyal radio LoRa terpantau pada ${document.getElementById('txt-lora').innerText}.`;
        } else if (perintah.includes('laporan') || perintah.includes('sistem')) {
            jawaban = `Laporan sistem pintar A.E.G.I.S: Tinggi air ${currentWaterLevel} sentimeter, suhu ${document.getElementById('teks-suhu').innerText} derajat, tegangan baterai ${document.getElementById('top-batt-v').innerText} volt. Seluruh sensor beroperasi normal.`;
        }
        addLog('AI', `Suara Keluar: "${jawaban}"`);
        let msg = new SpeechSynthesisUtterance(jawaban);
        msg.lang = 'id-ID'; msg.pitch = 1.05; msg.rate = 0.98;
        window.speechSynthesis.speak(msg);
        recognition.stop();
    };
    recognition.onstart = function() {
        aiTimeout = setTimeout(() => {
            if (aiListening) {
                addLog('AI', 'Sesi dengar AI selesai (Timeout).');
                toggleVoiceAI(true);
            }
        }, 7000);
    };
    recognition.onerror = function() { toggleVoiceAI(true); };
    recognition.onend = function() { if (aiListening) toggleVoiceAI(true); };
}

window.toggleVoiceAI = function(forceOff = false) {
    if (!recognition) {
        alert("Browser Anda belum mendukung Web Speech API. Gunakan Google Chrome atau Microsoft Edge.");
        return;
    }
    let btn = document.getElementById('btn-ai');
    let txt = document.getElementById('ai-text');
    try {
        if (aiListening || forceOff) {
            recognition.stop();
            clearTimeout(aiTimeout);
            aiListening = false;
            btn.classList.remove('listening');
            txt.innerText = "AI ASSISTANT";
        } else {
            recognition.start();
            aiListening = true;
            btn.classList.add('listening');
            txt.innerText = "MENDENGARKAN...";
            let msg = new SpeechSynthesisUtterance("Asisten pintar aktif, silakan bicara.");
            msg.lang = 'id-ID';
            window.speechSynthesis.speak(msg);
        }
    } catch (e) {}
};

// ==========================================
// KANVAS ANIMASI HUJAN & CUACA
// ==========================================
const canvas = document.getElementById('weather-canvas');
const ctxCanvas = canvas.getContext('2d');
canvas.width = window.innerWidth; canvas.height = window.innerHeight;
let particles = []; let isRaining = false;
window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });

function createRain() {
    particles = [];
    for (let i = 0; i < 100; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            speedY: Math.random() * 10 + 10,
            speedX: Math.random() * 2 - 1,
            len: Math.random() * 15 + 10
        });
    }
}
function drawRain() {
    ctxCanvas.clearRect(0, 0, canvas.width, canvas.height);
    ctxCanvas.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctxCanvas.lineWidth = 1.5;
    ctxCanvas.beginPath();
    for (let i = 0; i < particles.length; i++) {
        let p = particles[i];
        ctxCanvas.moveTo(p.x, p.y);
        ctxCanvas.lineTo(p.x + p.speedX, p.y + p.len);
        p.y += p.speedY; p.x += p.speedX;
        if (p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; }
    }
    ctxCanvas.stroke();
    if (isRaining) requestAnimationFrame(drawRain);
}

function playVoiceAlarm(status) {
    if (status === 'BAHAYA' && !alarmPlaying) {
        playBeep(2000, 'square', 0.5, 0.1);
        let msg = new SpeechSynthesisUtterance("Peringatan kritis! Tinggi air melewati batas bahaya. Menjalankan protokol pompa dan rute evakuasi sekarang!");
        msg.lang = 'id-ID';
        window.speechSynthesis.speak(msg);
        alarmPlaying = true;
    } else if (status !== 'BAHAYA') {
        alarmPlaying = false;
    }
}

setInterval(() => {
    const now = new Date();
    setText('teks-jam', now.toLocaleTimeString('id-ID', { hour12: false }));
    setText('teks-tanggal', now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase());
}, 1000);

// ==========================================
// TERMINAL COMMANDS
// ==========================================
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog'); if (!term) return;
    let time = new Date().toLocaleTimeString('id-ID', { hour12: false }); 
    let clr = tipe === 'ERR' ? '#ef4444' : (tipe === 'AI' ? '#c084fc' : (tipe === 'NET' ? '#10b981' : (tipe === 'CMD' ? '#facc15' : '#38bdf8')));
    term.innerHTML += `<div class="terminal-line"><span style="color:#64748b; width:65px;">${time}</span> <span style="color:${clr}; font-weight:bold; width:50px;">[${tipe}]</span> <span style="color:var(--text-main);">${pesan}</span></div>`;
    term.scrollTop = term.scrollHeight;
}

const cmdInputEl = document.getElementById('cmd-input');
if (cmdInputEl) {
    cmdInputEl.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && userRole === 'developer') {
            let cmd = this.value.toLowerCase().trim(); this.value = ''; addLog('CMD', `> ${cmd}`); playBeep(900, 'square', 0.05); 
            if (cmd === 'clear') { 
                document.getElementById('terminalLog').innerHTML = ''; 
            } else if (cmd === 'pump on') { 
                relayCH1_Pump = false; toggleRelayTest(1);
            } else if (cmd === 'pump off') { 
                relayCH1_Pump = true; toggleRelayTest(1);
            } else if (cmd === 'alarm on') { 
                relayCH2_Alarm = false; toggleRelayTest(2);
            } else if (cmd === 'alarm off') { 
                relayCH2_Alarm = true; toggleRelayTest(2);
            } else if (cmd === 'mode solar') { 
                toggleChargeMode('SOLAR');
            } else if (cmd === 'mode adaptor') { 
                toggleChargeMode('ADAPTOR');
            } else if (cmd === 'ats auto') {
                setATSMode(true);
            } else if (cmd === 'ats manual') {
                setATSMode(false);
            } else if (cmd === 'flash on') {
                toggleFlashLED('flash_on');
            } else if (cmd === 'flash off') {
                toggleFlashLED('flash_off');
            } else if (cmd.startsWith('setcam ')) {
                let ipBaru = cmd.replace('setcam ', '').trim();
                ESPCAM_IP = `http://${ipBaru}`;
                localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
                setText('cam-ip-label', `${ipBaru}:81`);
                addLog('CAM', `IP Kamera diubah ke: ${ESPCAM_IP}`);
            } else if (cmd.startsWith('setservo ')) {
                let ipServo = cmd.replace('setservo ', '').trim();
                ESPMAIN_IP = `http://${ipServo}`;
                localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
                addLog('SRV', `IP ESP32 Utama diubah ke: ${ESPMAIN_IP}`);
            } else { 
                addLog('ERR', `Perintah '${cmd}' tidak dikenali.`); 
            }
        }
    });
}

function initMapsAndCharts() {
    map = L.map('map', { zoomControl: true }).setView([KALIDERES_LAT, KALIDERES_LNG], 15); 
    currentTileLayer = L.tileLayer(mapTilesSatellite, { maxZoom: 19, attribution: 'Esri Satellite | A.E.G.I.S Smart Mapping' }).addTo(map);
    const btnMap = document.getElementById('btn-map-mode');
    if (btnMap) btnMap.innerHTML = '🗺️ MODE JALAN';
    
    iconAman = L.divIcon({ className: 'sonar-marker', iconSize: [18, 18] });
    iconWaspada = L.divIcon({ className: 'sonar-marker sonar-warning', iconSize: [18, 18] });
    iconBahaya = L.divIcon({ className: 'sonar-marker sonar-danger', iconSize: [18, 18] });

    markerHulu = L.marker([HULU_LAT, HULU_LNG], { icon: iconWaspada }).addTo(map).bindPopup('<b>NODE HULU</b><br>Pemantauan Aliran Masuk');
    markerHilir = L.marker([HILIR_LAT, HILIR_LNG], { icon: iconAman }).addTo(map).bindPopup('<b>NODE HILIR</b><br>Pemantauan Aliran Keluar');
    markerUtama = L.marker([KALIDERES_LAT, KALIDERES_LNG], { icon: iconAman }).addTo(map).bindTooltip('<div style="font-family:monospace; font-weight:bold; letter-spacing:1px; color:#38bdf8;">[ NODE UTAMA - KP. SAWAH MEDE ]</div>', { permanent: true, direction: 'top', className: 'custom-tooltip', offset: [0, -10] });

    var shelterIcon = L.divIcon({ className: 'shelter-icon', html: '🏥', iconSize: [30, 30] });
    markerPosko = L.marker([POSKO_LAT, POSKO_LNG], { icon: shelterIcon }).addTo(map);
    markerPosko.bindPopup('<div style="text-align:center; font-family:monospace;"><b style="font-size:14px; color:white; display:block; margin-bottom:5px;">TITIK EVAKUASI AMAN</b>POSKO KEL. KAMAL</div>', { className: 'evakuasi-popup', closeButton: false, autoClose: false, closeOnClick: false });

    routingControl = L.Routing.control({
        waypoints: [ L.latLng(KALIDERES_LAT, KALIDERES_LNG), L.latLng(POSKO_LAT, POSKO_LNG) ],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, show: false,
        createMarker: function() { return null; },
        lineOptions: { styles: [{ color: '#10b981', opacity: 1, weight: 5, className: 'animate-route' }] }
    });

    setTimeout(() => { map.invalidateSize(); }, 300);

    Chart.defaults.color = '#94a3b8'; Chart.defaults.borderColor = 'rgba(56,189,248,0.1)'; Chart.defaults.font.family = "'JetBrains Mono', monospace";
    
    // 1. Grafik Fluktuasi Elevasi Air
    ctx = document.getElementById('waterChart').getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, 250); grad.addColorStop(0, 'rgba(56, 189, 248, 0.4)'); grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
    waterChart = new Chart(ctx, { 
        type: 'line', 
        data: { 
            labels: [], 
            datasets: [
                { label: 'ACTUAL (CM)', data: [], borderColor: '#38bdf8', backgroundColor: grad, borderWidth: 2, fill: true, tension: 0.25, pointRadius: 2, pointBackgroundColor: '#38bdf8' },
                { label: 'AI PREDICTION', data: [], borderColor: '#c084fc', borderDash: [5, 5], backgroundColor: 'transparent', borderWidth: 2, fill: false, tension: 0.25, pointRadius: 0 }
            ] 
        }, 
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, suggestedMax: 150 }, x: { grid: { display: false } } } } 
    });

    // 2. Grafik Riwayat Tegangan Solar Panel vs Baterai/Aki + Batas 7.0V
    const ctxVolt = document.getElementById('powerVoltageChart').getContext('2d');
    powerVoltageChart = new Chart(ctxVolt, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: '☀️ SOLAR PANEL (V)', data: [], borderColor: '#facc15', backgroundColor: 'rgba(250, 204, 21, 0.12)', borderWidth: 2.5, fill: true, tension: 0.25, pointRadius: 3 },
                { label: '🔋 BATERAI / AKI (V)', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 2.5, fill: true, tension: 0.25, pointRadius: 3 },
                { label: '⚠️ BATAS CUTOVER ADAPTOR (7.0V)', data: [], borderColor: '#ef4444', borderDash: [6, 4], borderWidth: 1.8, fill: false, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true, position: 'top' } },
            scales: {
                y: { beginAtZero: true, suggestedMax: 18, title: { display: true, text: 'TEGANGAN (VOLT)' } },
                x: { grid: { display: false } }
            }
        }
    });

    // 3. Grafik Riwayat Arus Solar Panel vs Baterai/Aki (mA)
    const ctxCurr = document.getElementById('powerCurrentChart').getContext('2d');
    powerCurrentChart = new Chart(ctxCurr, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: '☀️ ARUS SOLAR (mA)', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.1)', borderWidth: 2, fill: true, tension: 0.25, pointRadius: 2 },
                { label: '🔋 ARUS BATERAI / AKI (mA)', data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.1)', borderWidth: 2, fill: true, tension: 0.25, pointRadius: 2 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true, position: 'top' } },
            scales: {
                y: { beginAtZero: true, suggestedMax: 600, title: { display: true, text: 'ARUS (mA)' } },
                x: { grid: { display: false } }
            }
        }
    });

    fetchWeather(); setInterval(fetchWeather, 300000);
}

async function fetchWeather() {
    if (!systemBooted) return;
    try {
        let res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${KALIDERES_LAT}&longitude=${KALIDERES_LNG}&current_weather=true`);
        let d = (await res.json()).current_weather.weathercode;
        let n = "CERAH", i = "☀️";
        if (isRaining) { isRaining = false; canvas.style.opacity = 0; particles = []; }
        if (d >= 1 && d <= 3) { n = "BERAWAN"; i = "⛅"; }
        else if (d >= 51) { n = d >= 80 ? "BADAI HUJAN" : "HUJAN LOKAL"; i = d >= 80 ? "⛈️" : "🌧️"; isRaining = true; createRain(); canvas.style.opacity = 1; drawRain(); }
        setText('teks-cuaca', n);
        setText('ikon-cuaca', i);
    } catch (e) {}
}

function startFirebaseListeners() {
    database.ref('kontrol').on('value', (snapshot) => {
        let ctrl = snapshot.val() || {};
        relayCH1_Pump   = (ctrl.pompa === "ON" || ctrl.pompa === "MENYALA");
        relayCH2_Alarm  = (ctrl.alarm === "ON" || ctrl.alarm === "MENYALA");
        relayCH3_Lamp   = (ctrl.lampu === "ON" || ctrl.lampu === "MENYALA");
        relayCH4_Charge = (ctrl.charge_mode === "ADAPTOR") ? "ADAPTOR" : "SOLAR";
        if (ctrl.ats_mode !== undefined) {
            isAutoATS = (ctrl.ats_mode === "AUTO");
        }

        // Auto-Sync IP Kamera jika ESP32-CAM melapor ke Firebase
        if (ctrl.cam_ip && ctrl.cam_ip !== "") {
            let newCam = `http://${ctrl.cam_ip}`;
            if (ESPCAM_IP !== newCam) {
                ESPCAM_IP = newCam;
                localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
                setText('cam-ip-label', `${ctrl.cam_ip}:81`);
            }
        }

        isPumpActive = relayCH1_Pump;
        if (isPumpActive) {
            document.getElementById('pump-icon').classList.add('active');
            document.getElementById('flow-bar').classList.add('active');
            setText('pump-status-text', 'RELAY CH1: ACTIVE (PUMP ON)');
            document.getElementById('pump-status-text').style.color = '#fff';
        } else {
            document.getElementById('pump-icon').classList.remove('active');
            document.getElementById('flow-bar').classList.remove('active');
            setText('pump-status-text', 'RELAY CH1: STANDBY');
            document.getElementById('pump-status-text').style.color = 'var(--text-muted)';
        }
        updateRelayButtonsUI();
    });

    database.ref('sensor/logs').limitToLast(20).on('value', (snapshot) => {
        globalHistory = [];
        snapshot.forEach(child => { globalHistory.push(child.val()); });
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = Number(data.water_level ?? 0);
            currentStatus = data.status ?? "AMAN";

            if (data.node_ip && data.node_ip !== "") {
                let detectedIP = `http://${data.node_ip}`;
                if (ESPMAIN_IP !== detectedIP) {
                    ESPMAIN_IP = detectedIP;
                    localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
                    addLog('SYS', `Node ESP32 Utama terdeteksi di: ${ESPMAIN_IP}`);
                }
            }

            // 1. Update Widget Utama Atas
            setText('teks-air', currentWaterLevel);
            setText('top-jarak', Number(data.distance_cm ?? Math.max(0, 150 - currentWaterLevel)).toFixed(1));
            setText('teks-suhu', data.temperature ?? "0.0");
            const sliderEl = document.getElementById('sim-slider');
            if (sliderEl) sliderEl.value = currentWaterLevel;
            setText('sim-val', currentWaterLevel);

            let flowLPM = Number(data.flow_rate_lpm ?? 0).toFixed(2);
            let massKGS = Number(data.mass_flow_kgs ?? 0).toFixed(2);

            setText('teks-flow', flowLPM);
            setText('top-mass', massKGS);
            setText('yf-flowrate', flowLPM);
            setText('coriolis-mass', massKGS);

            if (Number(flowLPM) > 0) {
                document.getElementById('flow-bar').classList.add('active');
            } else if (!isPumpActive) {
                document.getElementById('flow-bar').classList.remove('active');
            }

            // 2. Update Solar Panel (INA219 #1)
            let sV = Number(data.solar_v ?? 0).toFixed(2);
            let sI = Number(data.solar_i ?? 0).toFixed(0);
            let sP = Number(data.solar_p ?? (sV * sI)).toFixed(0);
            setText('top-solar-v', sV);
            setText('top-solar-i', sI);
            setText('top-solar-p', sP);
            setText('txt-solar', `${sV} V | ${sI} mA`);
            if (document.getElementById('bar-solar')) document.getElementById('bar-solar').style.width = `${Math.min(Math.round((Number(sV) / 18) * 100), 100)}%`;
            setText('det-solar-v', `${sV} V`);
            setText('det-solar-i', `${sI} mA`);
            setText('det-solar-p', `${sP} mW`);

            // 3. Update Baterai / Aki (INA219 #2) & Smart ATS (< 7.0V -> ADAPTOR)
            let numBattV = Number(data.batt_v ?? 0);
            let bV       = numBattV.toFixed(2);
            let bI       = Number(data.batt_i ?? 0).toFixed(0);
            let bPct     = data.batt_pct ?? 92;

            setText('top-batt-v', bV);
            setText('top-batt-i', bI);
            setText('top-batt-pct', `${bPct}%`);
            setText('txt-batt', `${bV} V | ${bI} mA (${bPct}%)`);
            if (document.getElementById('bar-batt')) document.getElementById('bar-batt').style.width = `${bPct}%`;
            if (document.getElementById('ats-curr-batt')) {
                const elAtsBatt = document.getElementById('ats-curr-batt');
                elAtsBatt.innerText = `${bV} V`;
                elAtsBatt.style.color = (numBattV > 0.1 && numBattV < ATS_CUTOVER_V) ? 'var(--bahaya)' : 'var(--aman)';
            }
            setText('det-batt-v', `${bV} V`);
            setText('det-batt-i', `${bI} mA`);
            setText('det-batt-pct', `${bPct}%`);

            const cardBatt = document.getElementById('card-batt');
            if (isAutoATS && numBattV > 0.1) {
                if (numBattV < ATS_CUTOVER_V && relayCH4_Charge !== "ADAPTOR") {
                    toggleChargeMode("ADAPTOR");
                    playBeep(1600, 'sawtooth', 0.4, 0.12);
                    addLog('PWR', `⚠️ SMART ATS: Tegangan Aki turun ke ${bV}V (< 7.0V)! Otomatis pindah ke ADAPTOR (CH4 ON).`);
                } else if (numBattV >= ATS_RECOVER_V && relayCH4_Charge === "ADAPTOR") {
                    toggleChargeMode("SOLAR");
                    addLog('PWR', `☀️ SMART ATS: Tegangan Aki pulih ke ${bV}V (>= 8.0V). Kembali ke SOLAR PANEL (CH4 OFF).`);
                }
            }
            if (cardBatt) {
                cardBatt.style.borderColor = (numBattV > 0.1 && numBattV < ATS_CUTOVER_V) ? 'var(--bahaya)' : 'rgba(16, 185, 129, 0.35)';
            }

            // 4. Update LoRa Ra-02 & AI Smart Forecast Widget
            let lRssi = data.lora_rssi ?? -78;
            setText('top-lora-rssi', lRssi);
            setText('top-last-sync', data.timestamp || "LIVE");
            setText('txt-lora', `${lRssi} dBm`);
            if (document.getElementById('bar-lora')) document.getElementById('bar-lora').style.width = `${Math.max(10, Math.min(100, 130 + Number(lRssi)))}%`;

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

            // 5. Logika Otomatis Relay & Rute Evakuasi Peta
            if (data.status === 'BAHAYA' && !isEvacActive) {
                isEvacActive = true; routingControl.addTo(map); markerPosko.openPopup(); map.setView([KALIDERES_LAT, KALIDERES_LNG], 15);
                database.ref('kontrol').update({ pompa: "ON", alarm: "ON", lampu: "OFF" });
                addLog('SYS', '🚨 PROTOKOL EVAKUASI AKTIF: Pompa (CH1) & Alarm (CH2) MENYALA!');
            } else if (data.status === 'WASPADA') {
                database.ref('kontrol').update({ lampu: "ON", alarm: "OFF" });
            } else if (data.status === 'AMAN' && isEvacActive) {
                isEvacActive = false; map.removeControl(routingControl); markerPosko.closePopup();
                database.ref('kontrol').update({ pompa: "OFF", alarm: "OFF", lampu: "OFF" });
                addLog('SYS', '✅ PROTOKOL DIHENTIKAN: Kondisi Kembali Aman.');
            }

            if (systemBooted && previousStatus !== null) {
                if ((previousStatus === 'BAHAYA' || previousStatus === 'WASPADA') && data.status === 'AMAN') {
                    playBeep(1000, 'sine', 0.4, 0.1);
                    let msg = new SpeechSynthesisUtterance("Perhatian. Genangan air telah surut. Kondisi lingkungan kembali aman.");
                    msg.lang = 'id-ID'; window.speechSynthesis.speak(msg);
                    addLog('SYS', '🔈 NOTIFIKASI SUARA: KONDISI KEMBALI AMAN.');
                }
            }
            if (systemBooted) { previousStatus = data.status; }

            let persentaseRisiko = Math.min(Math.round((currentWaterLevel / 150) * 100), 100);
            setText('txt-risiko', `${persentaseRisiko}%`);
            if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.width = `${persentaseRisiko}%`;
            setText('top-risiko', `${persentaseRisiko}%`);

            let statusHtml = ''; let dotColor = '#38bdf8';
            let cAir = document.getElementById('card-air'); let cStat = document.getElementById('card-status');

            if (data.status === 'AMAN') {
                document.body.classList.remove('danger-mode');
                statusHtml = `<span class="badge bg-aman">AMAN / NORMAL</span>`;
                cAir.style.borderColor = 'var(--glass-border)'; cStat.style.borderColor = 'var(--glass-border)';
                dotColor = '#10b981'; document.getElementById('bar-risiko').style.background = 'var(--aman)';
                markerUtama.setIcon(iconAman); markerHulu.setIcon(iconWaspada); markerHilir.setIcon(iconAman);
                fluidColor = 'rgba(16, 185, 129, 0.4)';
            } else if (data.status === 'WASPADA') {
                document.body.classList.remove('danger-mode');
                statusHtml = `<span class="badge bg-waspada">SIAGA / WASPADA</span>`;
                cAir.style.borderColor = 'var(--waspada)'; cStat.style.borderColor = 'var(--waspada)';
                dotColor = '#f59e0b'; document.getElementById('bar-risiko').style.background = 'var(--waspada)';
                markerUtama.setIcon(iconWaspada); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconWaspada);
                fluidColor = 'rgba(245, 158, 11, 0.4)';
            } else if (data.status === 'BAHAYA') {
                document.body.classList.add('danger-mode');
                statusHtml = `<span class="badge bg-bahaya">BAHAYA / EVAKUASI</span>`;
                cAir.style.borderColor = 'var(--bahaya)'; cStat.style.borderColor = 'var(--bahaya)';
                dotColor = '#ef4444'; document.getElementById('bar-risiko').style.background = 'var(--bahaya)';
                markerUtama.setIcon(iconBahaya); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconBahaya);
                fluidColor = 'rgba(239, 68, 68, 0.4)';
            }
            
            setHTML('teks-status', statusHtml);
            playVoiceAlarm(data.status);
            if (window.lastTimestamp !== data.timestamp) {
                addLog(data.status === 'BAHAYA' ? 'ERR' : 'DAT', `⬇️ CLOUD SYNC: Air=${currentWaterLevel}cm | Solar=${sV}V | Aki=${bV}V`);
                window.lastTimestamp = data.timestamp;
            }

            // 6. Update Grafik Elevasi Air
            let timeLabels = globalHistory.map(item => item.timestamp); 
            let actualData = globalHistory.map(item => item.water_level);
            let waterLabels = [...timeLabels, "T+1", "T+2"];
            let predData = new Array(globalHistory.length - 1).fill(null);
            
            if (globalHistory.length >= 2) {
                let p1 = globalHistory[globalHistory.length - 2].water_level; let p2 = currentWaterLevel;
                let momentum = p2 - p1; let f1 = Math.max(0, p2 + momentum); let f2 = Math.max(0, p2 + (momentum * 2));
                predData.push(p2, f1, f2);
            } else {
                predData.push(currentWaterLevel, currentWaterLevel, currentWaterLevel);
            }

            waterChart.data.labels = waterLabels; 
            waterChart.data.datasets[0].data = actualData; 
            waterChart.data.datasets[0].borderColor = dotColor;
            waterChart.data.datasets[0].pointBackgroundColor = dotColor;
            waterChart.data.datasets[1].data = predData;

            let newGrad = ctx.createLinearGradient(0, 0, 0, 250);
            if (data.status === 'BAHAYA') { newGrad.addColorStop(0, 'rgba(239, 68, 68, 0.5)'); newGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); }
            else if (data.status === 'WASPADA') { newGrad.addColorStop(0, 'rgba(245, 158, 11, 0.5)'); newGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)'); }
            else { newGrad.addColorStop(0, 'rgba(56, 189, 248, 0.3)'); newGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)'); }
            waterChart.data.datasets[0].backgroundColor = newGrad;
            waterChart.update();

            // 7. Update Grafik Tegangan & Arus Solar Panel vs Baterai/Aki
            if (powerVoltageChart && powerCurrentChart) {
                powerVoltageChart.data.labels = timeLabels;
                powerVoltageChart.data.datasets[0].data = globalHistory.map(item => Number(item.solar_v ?? 0));
                powerVoltageChart.data.datasets[1].data = globalHistory.map(item => Number(item.batt_v ?? 0));
                powerVoltageChart.data.datasets[2].data = new Array(timeLabels.length).fill(ATS_CUTOVER_V);
                powerVoltageChart.update();

                powerCurrentChart.data.labels = timeLabels;
                powerCurrentChart.data.datasets[0].data = globalHistory.map(item => Number(item.solar_i ?? 0));
                powerCurrentChart.data.datasets[1].data = globalHistory.map(item => Number(item.batt_i ?? 0));
                powerCurrentChart.update();
            }
            
            // 8. Update Tabel Overview & Tabel Penuh
            let tableHTML = '';
            let fullTableHTML = '';
            [...globalHistory].reverse().slice(0, 20).forEach(item => { 
                let ws = item.status === 'BAHAYA' ? '#ef4444' : (item.status === 'WASPADA' ? '#f59e0b' : '#10b981'); 
                let itemFlow  = item.flow_rate_lpm !== undefined ? `${Number(item.flow_rate_lpm).toFixed(1)} L/m` : '0.0 L/m';
                let itemSolar = item.solar_v !== undefined ? `${Number(item.solar_v).toFixed(2)}V (${Number(item.solar_i ?? 0).toFixed(0)}mA)` : '0.00V (0mA)';
                let itemBatt  = item.batt_v !== undefined ? `${Number(item.batt_v).toFixed(2)}V (${item.batt_pct ?? 92}%)` : '0.00V (92%)';
                let itemLora  = item.lora_rssi !== undefined ? `${item.lora_rssi} dBm` : '-78 dBm';
                let itemDist  = item.distance_cm !== undefined ? `${Number(item.distance_cm).toFixed(1)} cm` : `${Math.max(0, 150 - (item.water_level ?? 0)).toFixed(1)} cm`;
                let itemChg   = item.charge_mode ?? relayCH4_Charge;

                tableHTML += `<tr>
                    <td>${item.timestamp}</td>
                    <td><b>${item.water_level} cm</b></td>
                    <td>${itemFlow}</td>
                    <td>${item.temperature} °C</td>
                    <td style="color:#facc15;">${itemSolar}</td>
                    <td style="color:#10b981;">${itemBatt}</td>
                    <td style="color:#38bdf8;">${itemLora}</td>
                    <td style="color:${ws}; font-weight:bold;">${item.status}</td>
                </tr>`;

                fullTableHTML += `<tr>
                    <td>${item.timestamp}</td>
                    <td style="color:var(--primary);">${item.device_id}</td>
                    <td><b>${item.water_level} cm</b></td>
                    <td>${itemDist}</td>
                    <td>${itemFlow}</td>
                    <td>${item.temperature} °C</td>
                    <td style="color:#facc15;">${itemSolar}</td>
                    <td style="color:#10b981;">${itemBatt}</td>
                    <td style="color:${itemChg === 'ADAPTOR' ? '#c084fc' : '#10b981'}; font-weight:bold;">${itemChg}</td>
                    <td style="color:#38bdf8;">${itemLora}</td>
                    <td style="color:${ws}; font-weight:bold;">${item.status}</td>
                </tr>`;
            });
            setHTML('tableBody', tableHTML);
            setHTML('fullTableBody', fullTableHTML);
        }
    });
}

window.downloadCSV = function() {
    if (!globalHistory.length) return;
    let csv = "Waktu,Node ID,Water Level (cm),Distance (cm),Flow Rate (L/min),Temperature (C),Solar (V),Solar (mA),Battery (V),Battery (mA),Battery (%),Charge Mode (CH4),LoRa RSSI (dBm),Status\n";
    globalHistory.forEach(r => {
        csv += `${r.timestamp},${r.device_id},${r.water_level},${r.distance_cm ?? 0},${r.flow_rate_lpm ?? 0},${r.temperature},${r.solar_v ?? 0},${r.solar_i ?? 0},${r.batt_v ?? 0},${r.batt_i ?? 0},${r.batt_pct ?? 92},${r.charge_mode ?? 'SOLAR'},${r.lora_rssi ?? -78},${r.status}\n`;
    });
    let blob = new Blob([csv], { type: 'text/csv' });
    let a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aegis_smart_telemetry_full.csv';
    a.click();
};

window.generatePDF = function() {
    const element = document.getElementById('report-area');
    html2pdf().from(element).save('AEGIS_Smart_Report.pdf');
};
