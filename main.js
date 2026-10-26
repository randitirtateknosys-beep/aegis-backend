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

// ================= PENGATURAN IP KAMERA & IP ESP32 UTAMA =================
let ESPCAM_IP  = localStorage.getItem('aegis_cam_ip')  || "http://10.78.168.1";
let ESPMAIN_IP = localStorage.getItem('aegis_main_ip') || "";

let currentCamZoom = 1.0;
let isCamCoverMode = false;
let cloudPanAngle  = 90;
let cloudTiltAngle = 90;
const SERVO_STEP   = 15;

// Status Memori 4-Channel Relay
let relayCH1_Pump   = false;
let relayCH2_Alarm  = false;
let relayCH3_Lamp   = false;
let relayCH4_Charge = "SOLAR";
let testAlarmLoop   = null;

window.moveCam = function(direction) {
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
    // CH1: Pompa Air
    const btn1 = document.getElementById('btn-relay-ch1');
    const bdg1 = document.getElementById('badge-ch1');
    const topPump = document.getElementById('top-pump-stat');
    if (btn1 && bdg1) {
        bdg1.innerText = relayCH1_Pump ? "ON" : "OFF";
        btn1.style.background = relayCH1_Pump ? "var(--primary)" : "transparent";
        btn1.style.color      = relayCH1_Pump ? "#000" : "var(--primary)";
    }
    if (topPump) topPump.innerText = relayCH1_Pump ? "ON" : "OFF";

    // CH2: Alarm Sirine
    const btn2 = document.getElementById('btn-relay-ch2');
    const bdg2 = document.getElementById('badge-ch2');
    const topAlarm = document.getElementById('top-alarm-stat');
    if (btn2 && bdg2) {
        bdg2.innerText = relayCH2_Alarm ? "ON" : "OFF";
        btn2.style.background = relayCH2_Alarm ? "var(--bahaya)" : "transparent";
        btn2.style.color      = relayCH2_Alarm ? "#fff" : "var(--bahaya)";
    }
    if (topAlarm) topAlarm.innerText = relayCH2_Alarm ? "ON" : "OFF";

    // CH3: Lampu Waspada Orange
    const btn3 = document.getElementById('btn-relay-ch3');
    const bdg3 = document.getElementById('badge-ch3');
    if (btn3 && bdg3) {
        bdg3.innerText = relayCH3_Lamp ? "ON" : "OFF";
        btn3.style.background = relayCH3_Lamp ? "var(--waspada)" : "transparent";
        btn3.style.color      = relayCH3_Lamp ? "#000" : "var(--waspada)";
    }

    // CH4: Mode Charging (Solar Panel vs Adaptor)
    const btn4 = document.getElementById('btn-relay-ch4');
    const bdg4 = document.getElementById('badge-ch4');
    const topChg = document.getElementById('top-charge-mode');
    if (btn4 && bdg4) {
        if (relayCH4_Charge === "ADAPTOR") {
            bdg4.innerText = "🔌 ADAPTOR";
            btn4.style.borderColor = "#a855f7";
            btn4.style.color       = "#fff";
            btn4.style.background  = "rgba(168, 85, 247, 0.35)";
            if (topChg) { topChg.innerText = "🔌 ADAPTOR DC"; topChg.style.color = "#a855f7"; }
        } else {
            bdg4.innerText = "☀️ SOLAR";
            btn4.style.borderColor = "var(--aman)";
            btn4.style.color       = "var(--aman)";
            btn4.style.background  = "transparent";
            if (topChg) { topChg.innerText = "☀️ SOLAR PANEL"; topChg.style.color = "var(--aman)"; }
        }
    }
}

window.toggleRelayTest = function(channel) {
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
    if (forceMode) {
        relayCH4_Charge = forceMode;
    } else {
        relayCH4_Charge = (relayCH4_Charge === "SOLAR") ? "ADAPTOR" : "SOLAR";
    }
    database.ref('kontrol').update({ charge_mode: relayCH4_Charge });
    if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/relay?ch=4&val=${relayCH4_Charge}`).catch(() => {});
    addLog('PWR', `⚡ CH4 Sumber Pengisian diubah ke: MODE ${relayCH4_Charge}`);
    updateRelayButtonsUI();
};

window.toggleFlashLED = function(customAction = 'flash') {
    fetch(`${ESPCAM_IP}/action?go=${customAction}`)
        .then(res => res.json())
        .then(data => {
            const levels = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
            const lvlText = levels[data.flash] || 'OFF';
            const btnFlash = document.getElementById('btn-flash');
            const badgeFlash = document.getElementById('cam-flash-badge');
            if (btnFlash) {
                btnFlash.innerText = `💡 FLASH: ${lvlText}`;
                btnFlash.style.background = data.flash > 0 ? '#facc15' : 'transparent';
                btnFlash.style.color = data.flash > 0 ? '#000' : '#facc15';
            }
            if (badgeFlash) badgeFlash.innerText = lvlText;
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
    const btnFit = document.getElementById('btn-fit');
    if (camEl) camEl.style.objectFit = isCamCoverMode ? 'cover' : 'contain';
    if (btnFit) btnFit.innerText = isCamCoverMode ? '🖼️ FIT LAYAR' : '🖼️ FULL SENSOR';
};

function applyCamTransform() {
    const camEl = document.getElementById('espcam-stream');
    const zoomLbl = document.getElementById('cam-zoom-label');
    if (camEl) camEl.style.transform = `scale(${currentCamZoom})`;
    if (zoomLbl) zoomLbl.innerText = `${currentCamZoom.toFixed(1)}x`;
}

window.changeCamIPPrompt = function() {
    let currentIP = ESPCAM_IP.replace('http://', '');
    let inputIP = prompt("Masukkan IP ESP32-CAM Anda (contoh: 10.78.168.1):", currentIP);
    if (inputIP && inputIP.trim() !== "") {
        let cleanIP = inputIP.replace('http://', '').replace(':81/stream', '').trim();
        ESPCAM_IP = `http://${cleanIP}`;
        localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        const camEl = document.getElementById('espcam-stream');
        const labelEl = document.getElementById('cam-ip-label');
        if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
        if (labelEl) labelEl.innerText = `${cleanIP}:81`;
        addLog('CAM', `Streaming kamera diarahkan ke ${ESPCAM_IP}:81/stream`);
    }
};

window.toggleFullscreenCam = function() {
    const camBox = document.getElementById('cctv-feed');
    if (!document.fullscreenElement) {
        camBox.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
};

let currentWaterLevel = 0; let currentStatus = "AMAN"; let previousStatus = null;
let isPumpActive = false; let isEvacActive = false; let alarmPlaying = false;
let systemBooted = false; let globalHistory = []; window.lastTimestamp = null;
let iconAman, iconWaspada, iconBahaya;

// ==========================================
// TECHNICAL ART: CFD FLUID DYNAMICS 
// ==========================================
let fluidOffset = 0; let fluidColor = 'rgba(14, 165, 233, 0.4)';
function renderFluid() {
    const fCanvas = document.getElementById('fluid-canvas'); if(!fCanvas) return;
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
// AUDIO & 3D TACTICAL MODE
// ==========================================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq = 800, type = 'sine', duration = 0.1, vol = 0.05) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    let osc1 = audioCtx.createOscillator(); let osc2 = audioCtx.createOscillator(); let gain = audioCtx.createGain();
    osc1.type = type; osc1.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc2.type = 'triangle'; osc2.frequency.setValueAtTime(freq * 1.5, audioCtx.currentTime); 
    gain.gain.setValueAtTime(vol, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
    osc1.connect(gain); osc2.connect(gain); gain.connect(audioCtx.destination);
    osc1.start(); osc2.start(); osc1.stop(audioCtx.currentTime + duration); osc2.stop(audioCtx.currentTime + duration);
}
document.querySelectorAll('.btn-sfx').forEach(btn => { btn.addEventListener('click', () => playBeep(1200, 'square', 0.1)); });

window.toggleTactical3D = function() {
    document.getElementById('hologram-area').classList.toggle('tactical-3d-active');
    playBeep(2000, 'sawtooth', 0.3, 0.1); addLog('SYS', '3D HOLOGRAPHIC TACTICAL VIEW TOGGLED.');
};

window.toggleDeck = function() { document.getElementById('control-deck').classList.toggle('open'); playBeep(1200, 'square', 0.1); };
window.updateSimValue = function(val) { document.getElementById('sim-val').innerText = val; playBeep(400 + parseInt(val)*5, 'sine', 0.05, 0.01); };
window.pushSimData = function(val) {
    let numVal = parseInt(val); let stat = numVal >= 100 ? "BAHAYA" : (numVal >= 70 ? "WASPADA" : "AMAN");
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    database.ref('sensor/logs').push({
        device_id: "NODE-SIM-1",
        status: stat,
        temperature: Number((28 + Math.random() * 2).toFixed(1)),
        timestamp: timeStr,
        water_level: numVal,
        distance_cm: Math.max(0, 150 - numVal),
        flow_rate_lpm: 0.0,
        mass_flow_kgs: 0.0
    });
    addLog('SYS', `SIMULASI AKTIF: Push ${numVal}cm ke Firebase!`); if(stat === 'BAHAYA') forceGlitch();
};
window.forceGlitch = function() { document.body.classList.add('glitch-effect'); playBeep(100, 'sawtooth', 0.6, 0.3); setTimeout(() => document.body.classList.remove('glitch-effect'), 600); };

// ==========================================
// YOLOv10n AI SIMULATION
// ==========================================
let yoloActive = false; let yoloInterval;
window.toggleYolo = function() {
    yoloActive = !yoloActive; const yCanvas = document.getElementById('yolo-canvas');
    if(yoloActive) {
        yCanvas.style.display = 'block'; addLog('AI', 'MENGAKTIFKAN YOLOv10n OBJECT DETECTION...'); playBeep(1500, 'square', 0.2);
        yoloInterval = setInterval(() => {
            yCanvas.innerHTML = ''; let numBoxes = Math.floor(Math.random() * 2) + 1;
            for(let i=0; i<numBoxes; i++) {
                let w = 60 + Math.random() * 70; let h = 50 + Math.random() * 60;
                let x = Math.random() * (yCanvas.clientWidth - w); let y = Math.random() * (yCanvas.clientHeight - h);
                let conf = (85 + Math.random() * 14).toFixed(1);
                let classes = ['WATER_SURFACE', 'DEBRIS', 'DRAIN_FLOW']; let cls = classes[Math.floor(Math.random()*classes.length)];
                yCanvas.innerHTML += `<div class="yolo-bbox" style="width:${w}px; height:${h}px; left:${x}px; top:${y}px;"><div class="yolo-label">${cls} ${conf}%</div></div>`;
            }
        }, 1200);
    } else {
        yCanvas.style.display = 'none'; clearInterval(yoloInterval); yCanvas.innerHTML = ''; addLog('AI', 'YOLOv10n DINONAKTIFKAN.');
    }
};
function simulatePCB() { setInterval(() => { document.getElementById('led-rx').classList.toggle('active'); if(Math.random() > 0.5) document.getElementById('led-tx').classList.toggle('active'); }, 150); }

// LOGIN & BOOT SEQUENCE
document.getElementById('pass-input').addEventListener('keypress', function(e) { if(e.key === 'Enter') verifyLogin(); });
function verifyLogin() {
    let pass = document.getElementById('pass-input').value.toLowerCase();
    if(pass === 'admin' || pass === 'aegis2026') {
        playBeep(1000, 'square', 0.2, 0.1); document.getElementById('login-screen').style.opacity = '0';
        setTimeout(() => { document.getElementById('login-screen').style.visibility = 'hidden'; startBootSequence(); }, 1000);
    } else { playBeep(200, 'sawtooth', 0.3, 0.1); document.getElementById('login-error').style.display = 'block'; document.getElementById('pass-input').value = ''; }
}

function startBootSequence() {
    document.getElementById('boot-screen').style.visibility = 'visible'; document.getElementById('boot-screen').style.opacity = '1';
    const bootLog = document.getElementById('boot-log');
    const messages = [ "> MENGHUBUNGKAN KE FIREBASE WEBSOCKET...", "> MENGKALIBRASI MODUL RELAY 4-CHANNEL & INA219...", "> MENGAKTIFKAN STREAMING ESP32-CAM & SERVO...", "> SISTEM A.E.G.I.S CLOUD SIAP." ];
    let i = 0;
    let bootInterval = setInterval(() => {
        if(i < messages.length) { bootLog.innerHTML += messages[i] + "<br>"; playBeep(400 + (i*100), 'square', 0.05, 0.02); i++; } 
        else {
            clearInterval(bootInterval); setTimeout(() => {
                playBeep(1500, 'sine', 0.3, 0.1); document.getElementById('boot-screen').style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('boot-screen').style.visibility = 'hidden';
                    document.getElementById('dashboard-core').style.display = 'block';
                    setTimeout(() => {
                        document.getElementById('dashboard-core').style.opacity = '1';
                        systemBooted = true;
                        const camImg = document.getElementById('espcam-stream');
                        const camLbl = document.getElementById('cam-ip-label');
                        if (camImg) camImg.src = `${ESPCAM_IP}:81/stream`;
                        if (camLbl) camLbl.innerText = `${ESPCAM_IP.replace('http://', '')}:81`;
                        initMapsAndCharts();
                        startFirebaseListeners();
                        renderFluid();
                        simulatePCB();
                    }, 100);
                }, 1000);
            }, 500);
        }
    }, 400);
}

// ==========================================
// REAL MAP ENGINE (SATELLITE & OPENSTREETMAP)
// ==========================================
let isLightMode = false;
let isSatelliteMode = true;
var mapTilesSatellite = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
var mapTilesStreet    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
var currentTileLayer; var map, waterChart, routingControl, ctx;

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

function toggleTheme() {
    isLightMode = !isLightMode; document.body.classList.toggle('light-mode'); let btn = document.getElementById('btn-theme');
    if(isLightMode) { btn.innerHTML = '🌙 GELAP'; Chart.defaults.color = '#64748b'; Chart.defaults.borderColor = 'rgba(0,0,0,0.1)'; } 
    else { btn.innerHTML = '🌞 TERANG'; Chart.defaults.color = '#94a3b8'; Chart.defaults.borderColor = 'rgba(14,165,233,0.1)'; }
    waterChart.update();
}

// AI ASSISTANT NLP
let aiListening = false; let aiTimeout;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; const recognition = SpeechRecognition ? new SpeechRecognition() : null;
if(recognition) {
    recognition.lang = 'id-ID'; recognition.continuous = true; recognition.interimResults = false;
    recognition.onresult = function(e) {
        clearTimeout(aiTimeout); const perintah = e.results[e.results.length - 1][0].transcript.toLowerCase(); addLog('AI', `In: "${perintah}"`);
        let jawaban = "Sistem gagal menemukan referensi dalam memori lokal. Harap ulangi instruksi.";
        if(perintah.includes('air') || perintah.includes('banjir')) jawaban = `Tinggi air saat ini ${currentWaterLevel} sentimeter. Status ${currentStatus}.`; 
        else if(perintah.includes('cuaca')) jawaban = `Pemindaian satelit menunjukkan cuaca ${document.getElementById('teks-cuaca').innerText}.`; 
        else if(perintah.includes('pompa') || perintah.includes('flow')) jawaban = `Pompa berstatus ${relayCH1_Pump ? 'menyala' : 'siaga'} dengan aliran ${document.getElementById('yf-flowrate').innerText} liter per menit.`; 
        else if(perintah.includes('lampu') || perintah.includes('flash')) { toggleFlashLED(); jawaban = "Mengubah status lampu flash kamera."; }
        else if(perintah.includes('suhu')) jawaban = `Termal internal stabil di angka ${document.getElementById('teks-suhu').innerText} derajat celcius.`;
        else if(perintah.includes('solar')) jawaban = `Tegangan panel surya saat ini ${document.getElementById('top-solar-v').innerText} volt dengan arus ${document.getElementById('top-solar-i').innerText} miliampere.`;
        else if(perintah.includes('baterai') || perintah.includes('aki')) jawaban = `Status daya baterai ${document.getElementById('txt-batt').innerText}. Mode pengisian menggunakan ${relayCH4_Charge}.`;
        else if(perintah.includes('sinyal') || perintah.includes('lora')) jawaban = `Kekuatan sinyal LoRa terpantau pada ${document.getElementById('txt-lora').innerText}.`;
        else if(perintah.includes('laporan') || perintah.includes('sistem')) jawaban = `Diagnosis penuh: Air ${currentWaterLevel} senti, Suhu ${document.getElementById('teks-suhu').innerText} derajat, Baterai ${document.getElementById('top-batt-v').innerText} volt. Seluruh instrumen beroperasi normal.`;
        addLog('AI', `Out: "${jawaban}"`); let msg = new SpeechSynthesisUtterance(jawaban); msg.lang = 'id-ID'; msg.pitch = 1.1; msg.rate = 0.95; window.speechSynthesis.speak(msg); recognition.stop();
    };
    recognition.onstart = function() { aiTimeout = setTimeout(() => { if(aiListening) { addLog('AI', 'Membatalkan sesi dengar (Timeout).'); toggleVoiceAI(true); } }, 6000); };
    recognition.onerror = function() { toggleVoiceAI(true); }; recognition.onend = function() { if(aiListening) toggleVoiceAI(true); };
}
function toggleVoiceAI(forceOff = false) {
    if(!recognition) return; let btn = document.getElementById('btn-ai'); let txt = document.getElementById('ai-text');
    try {
        if(aiListening || forceOff) { recognition.stop(); clearTimeout(aiTimeout); aiListening = false; btn.classList.remove('listening'); txt.innerText = "AI ASSISTANT"; } 
        else { recognition.start(); aiListening = true; btn.classList.add('listening'); txt.innerText = "LISTENING..."; let msg = new SpeechSynthesisUtterance("Mendengarkan instruksi komandan."); msg.lang = 'id-ID'; window.speechSynthesis.speak(msg); }
    } catch (e) {}
}

// KANVAS CUACA
const canvas = document.getElementById('weather-canvas'); const ctxCanvas = canvas.getContext('2d'); canvas.width = window.innerWidth; canvas.height = window.innerHeight;
let particles = []; let isRaining = false;
window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
function createRain() { particles=[]; for(let i=0; i<100; i++) { particles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, speedY: Math.random() * 10 + 10, speedX: Math.random() * 2 - 1, len: Math.random() * 15 + 10 }); } }
function drawRain() {
    ctxCanvas.clearRect(0, 0, canvas.width, canvas.height); ctxCanvas.strokeStyle = 'rgba(14, 165, 233, 0.4)'; ctxCanvas.lineWidth = 1.5; ctxCanvas.beginPath();
    for(let i=0; i<particles.length; i++) { let p = particles[i]; ctxCanvas.moveTo(p.x, p.y); ctxCanvas.lineTo(p.x + p.speedX, p.y + p.len); p.y += p.speedY; p.x += p.speedX; if(p.y > canvas.height) { p.y = -10; p.x = Math.random() * canvas.width; } }
    ctxCanvas.stroke(); if(isRaining) requestAnimationFrame(drawRain);
}

function playVoiceAlarm(status) {
    if (status === 'BAHAYA' && !alarmPlaying) {
        playBeep(2000, 'square', 0.5, 0.1); let msg = new SpeechSynthesisUtterance("Peringatan kritis! Menjalankan protokol evakuasi sekarang!"); msg.lang = 'id-ID'; window.speechSynthesis.speak(msg); alarmPlaying = true;
    } else if (status !== 'BAHAYA') { alarmPlaying = false; }
}

setInterval(() => { const now = new Date(); document.getElementById('teks-jam').innerText = now.toLocaleTimeString('id-ID', { hour12: false }); document.getElementById('teks-tanggal').innerText = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase(); }, 1000);

// ==========================================
// TERMINAL COMMANDS
// ==========================================
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog'); let time = new Date().toLocaleTimeString('id-ID', { hour12: false }); 
    let clr = tipe === 'ERR' ? '#ef4444' : (tipe === 'AI' ? '#a855f7' : (tipe==='NET' ? '#10b981' : (tipe==='CMD' ? '#facc15' : '#0ea5e9')));
    term.innerHTML += `<div class="terminal-line"><span style="color:#64748b; width:65px;">${time}</span> <span style="color:${clr}; font-weight:bold; width:50px;">[${tipe}]</span> <span style="color:var(--text-main);">${pesan}</span></div>`; term.scrollTop = term.scrollHeight;
}

document.getElementById('cmd-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
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
        } else if (cmd === 'flash on') {
            toggleFlashLED('flash_on');
        } else if (cmd === 'flash off') {
            toggleFlashLED('flash_off');
        } else if (cmd.startsWith('setcam ')) {
            let ipBaru = cmd.replace('setcam ', '').trim();
            ESPCAM_IP = `http://${ipBaru}`;
            localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
            const camEl = document.getElementById('espcam-stream');
            const lblEl = document.getElementById('cam-ip-label');
            if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
            if (lblEl) lblEl.innerText = `${ipBaru}:81`;
            addLog('CAM', `IP Kamera diubah ke: ${ESPCAM_IP}`);
        } else if (cmd.startsWith('setservo ')) {
            let ipServo = cmd.replace('setservo ', '').trim();
            ESPMAIN_IP = `http://${ipServo}`;
            localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
            addLog('SRV', `IP ESP32 Utama diubah ke: ${ESPMAIN_IP}`);
        } else if (cmd === 'override aegis') { 
            playBeep(2500, 'sawtooth', 0.5, 0.2);
            document.body.classList.add('danger-mode');
            setTimeout(() => { document.body.classList.remove('danger-mode'); }, 1000);
            addLog('SYS', 'BYPASSING SECURITY PROTOCOLS...');
            setTimeout(() => addLog('SYS', 'OVERCLOCKING ESP32 TO 240MHz... SUCCESS'), 800);
            setTimeout(() => addLog('AI', 'GHOST IN THE MACHINE ACTIVATED. ALL SYSTEMS NOMINAL.'), 1600);
            setTimeout(() => { let msg = new SpeechSynthesisUtterance("Sistem berhasil diambil alih."); msg.lang='id-ID'; window.speechSynthesis.speak(msg); }, 2000);
        } else { 
            addLog('ERR', `Command '${cmd}' tidak ditemukan.`); 
        }
    }
});

function initMapsAndCharts() {
    map = L.map('map', {zoomControl: true}).setView([KALIDERES_LAT, KALIDERES_LNG], 15); 
    currentTileLayer = L.tileLayer(mapTilesSatellite, { maxZoom: 19, attribution: 'Esri Satellite | A.E.G.I.S Mapping' }).addTo(map);
    const btnMap = document.getElementById('btn-map-mode');
    if (btnMap) btnMap.innerHTML = '🗺️ MODE JALAN';
    
    iconAman = L.divIcon({className: 'sonar-marker', iconSize: [18,18]});
    iconWaspada = L.divIcon({className: 'sonar-marker sonar-warning', iconSize: [18,18]});
    iconBahaya = L.divIcon({className: 'sonar-marker sonar-danger', iconSize: [18,18]});

    markerHulu = L.marker([HULU_LAT, HULU_LNG], {icon: iconWaspada}).addTo(map).bindPopup('<b>NODE HULU</b><br>Pemantauan Aliran Masuk');
    markerHilir = L.marker([HILIR_LAT, HILIR_LNG], {icon: iconAman}).addTo(map).bindPopup('<b>NODE HILIR</b><br>Pemantauan Aliran Keluar');
    markerUtama = L.marker([KALIDERES_LAT, KALIDERES_LNG], {icon: iconAman}).addTo(map).bindTooltip('<div style="font-family:monospace; font-weight:bold; letter-spacing:1px; color:#0ea5e9;">[ NODE UTAMA - KP. SAWAH MEDE ]</div>', {permanent: true, direction: 'top', className: 'custom-tooltip', offset: [0, -10]});

    var shelterIcon = L.divIcon({className: 'shelter-icon', html: '🏥', iconSize: [30,30]});
    markerPosko = L.marker([POSKO_LAT, POSKO_LNG], {icon: shelterIcon}).addTo(map);
    markerPosko.bindPopup('<div style="text-align:center; font-family:monospace;"><b style="font-size:14px; color:white; display:block; margin-bottom:5px;">SECURE ZONE</b>POSKO KEL. KAMAL</div>', {className: 'evakuasi-popup', closeButton: false, autoClose: false, closeOnClick: false});

    routingControl = L.Routing.control({
        waypoints: [ L.latLng(KALIDERES_LAT, KALIDERES_LNG), L.latLng(POSKO_LAT, POSKO_LNG) ],
        routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, show: false,
        createMarker: function() { return null; },
        lineOptions: { styles: [{color: '#10b981', opacity: 1, weight: 5, className: 'animate-route'}] }
    });

    setTimeout(() => { map.invalidateSize(); }, 300);

    Chart.defaults.color = '#64748b'; Chart.defaults.borderColor = 'rgba(14,165,233,0.1)'; Chart.defaults.font.family = "'Courier New', Courier, monospace";
    ctx = document.getElementById('waterChart').getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, 250); grad.addColorStop(0, 'rgba(14, 165, 233, 0.4)'); grad.addColorStop(1, 'rgba(14, 165, 233, 0.0)');
    
    waterChart = new Chart(ctx, { 
        type: 'line', 
        data: { 
            labels: [], 
            datasets: [
                { label: 'ACTUAL', data: [], borderColor: '#0ea5e9', backgroundColor: grad, borderWidth: 2, fill: true, tension: 0.2, pointRadius: 2, pointBackgroundColor: '#0ea5e9' },
                { label: 'AI PREDICTION', data: [], borderColor: '#ef4444', borderDash: [5, 5], backgroundColor: 'transparent', borderWidth: 2, fill: false, tension: 0.2, pointRadius: 0 }
            ] 
        }, 
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, suggestedMax: 150 }, x: { grid: { display: false } } } } 
    });

    fetchWeather(); setInterval(fetchWeather, 300000);
}

async function fetchWeather() {
    if(!systemBooted) return;
    try {
        let res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${KALIDERES_LAT}&longitude=${KALIDERES_LNG}&current_weather=true`); let d = (await res.json()).current_weather.weathercode;
        let n = "CERAH", i = "☀️"; if(isRaining) { isRaining = false; canvas.style.opacity = 0; particles = []; }
        if(d >= 1 && d <= 3) { n = "BERAWAN"; i = "⛅"; } else if(d >= 51) { n = d>=80 ? "BADAI HUJAN" : "HUJAN LOKAL"; i = d>=80 ? "⛈️" : "🌧️"; isRaining = true; createRain(); canvas.style.opacity = 1; drawRain(); }
        document.getElementById('teks-cuaca').innerText = n; document.getElementById('ikon-cuaca').innerText = i;
    } catch(e) {}
}

function startFirebaseListeners() {
    database.ref('kontrol').on('value', (snapshot) => {
        let ctrl = snapshot.val() || {};
        relayCH1_Pump   = (ctrl.pompa === "ON" || ctrl.pompa === "MENYALA");
        relayCH2_Alarm  = (ctrl.alarm === "ON" || ctrl.alarm === "MENYALA");
        relayCH3_Lamp   = (ctrl.lampu === "ON" || ctrl.lampu === "MENYALA");
        relayCH4_Charge = (ctrl.charge_mode === "ADAPTOR") ? "ADAPTOR" : "SOLAR";

        isPumpActive = relayCH1_Pump;
        if (isPumpActive) {
            document.getElementById('pump-icon').classList.add('active');
            document.getElementById('flow-bar').classList.add('active');
            document.getElementById('pump-status-text').innerText = 'RELAY CH1: ACTIVE (PUMP ON)';
            document.getElementById('pump-status-text').style.color = '#fff';
        } else {
            document.getElementById('pump-icon').classList.remove('active');
            document.getElementById('flow-bar').classList.remove('active');
            document.getElementById('pump-status-text').innerText = 'RELAY CH1: STANDBY';
            document.getElementById('pump-status-text').style.color = 'var(--text-muted)';
        }
        updateRelayButtonsUI();
    });

    database.ref('sensor/logs').limitToLast(20).on('value', (snapshot) => {
        globalHistory = [];
        snapshot.forEach(child => { globalHistory.push(child.val()); });
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = data.water_level ?? 0;
            currentStatus = data.status ?? "AMAN";

            if (data.node_ip && data.node_ip !== "") {
                let detectedIP = `http://${data.node_ip}`;
                if (ESPMAIN_IP !== detectedIP) {
                    ESPMAIN_IP = detectedIP;
                    localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
                    addLog('SYS', `Node ESP32 Utama terdeteksi di: ${ESPMAIN_IP}`);
                }
            }

            // 1. Update Kartu Utama Atas (Air, Jarak Sensor, Suhu, Flow Meter)
            document.getElementById('teks-air').innerText = currentWaterLevel;
            if (document.getElementById('top-jarak')) {
                document.getElementById('top-jarak').innerText = Number(data.distance_cm ?? Math.max(0, 150 - currentWaterLevel)).toFixed(1);
            }
            document.getElementById('teks-suhu').innerText = data.temperature ?? "0.0";
            document.getElementById('sim-slider').value = currentWaterLevel;
            document.getElementById('sim-val').innerText = currentWaterLevel;

            let flowLPM = Number(data.flow_rate_lpm ?? 0).toFixed(2);
            let massKGS = Number(data.mass_flow_kgs ?? 0).toFixed(2);

            if (document.getElementById('teks-flow')) document.getElementById('teks-flow').innerText = flowLPM;
            if (document.getElementById('top-mass')) document.getElementById('top-mass').innerText = massKGS;
            if (document.getElementById('yf-flowrate')) document.getElementById('yf-flowrate').innerText = flowLPM;
            if (document.getElementById('coriolis-mass')) document.getElementById('coriolis-mass').innerText = massKGS;

            if (Number(flowLPM) > 0) {
                document.getElementById('flow-bar').classList.add('active');
            } else if (!isPumpActive) {
                document.getElementById('flow-bar').classList.remove('active');
            }

            // 2. Update Kartu Atas & Bar Indikator: Solar Panel (INA219 #1)
            let sV = Number(data.solar_v ?? 0).toFixed(2);
            let sI = Number(data.solar_i ?? 0).toFixed(0);
            let sP = Number(data.solar_p ?? (sV * sI)).toFixed(0);
            if (document.getElementById('top-solar-v')) document.getElementById('top-solar-v').innerText = sV;
            if (document.getElementById('top-solar-i')) document.getElementById('top-solar-i').innerText = sI;
            if (document.getElementById('top-solar-p')) document.getElementById('top-solar-p').innerText = sP;
            if (document.getElementById('txt-solar')) document.getElementById('txt-solar').innerText = `${sV} V | ${sI} mA`;
            if (document.getElementById('bar-solar')) document.getElementById('bar-solar').style.width = `${Math.min(Math.round((Number(sV) / 18) * 100), 100)}%`;

            // 3. Update Kartu Atas & Bar Indikator: Baterai / Aki (INA219 #2)
            let bV   = Number(data.batt_v ?? 0).toFixed(2);
            let bI   = Number(data.batt_i ?? 0).toFixed(0);
            let bPct = data.batt_pct ?? 92;
            if (document.getElementById('top-batt-v')) document.getElementById('top-batt-v').innerText = bV;
            if (document.getElementById('top-batt-i')) document.getElementById('top-batt-i').innerText = bI;
            if (document.getElementById('top-batt-pct')) document.getElementById('top-batt-pct').innerText = `${bPct}%`;
            if (document.getElementById('txt-batt')) document.getElementById('txt-batt').innerText = `${bV} V | ${bI} mA (${bPct}%)`;
            if (document.getElementById('bar-batt')) document.getElementById('bar-batt').style.width = `${bPct}%`;

            // 4. Update Kartu Atas & Bar Indikator: LoRa Ra-02 SX1278
            let lRssi = data.lora_rssi ?? -78;
            if (document.getElementById('top-lora-rssi')) document.getElementById('top-lora-rssi').innerText = lRssi;
            if (document.getElementById('txt-lora')) document.getElementById('txt-lora').innerText = `${lRssi} dBm`;
            if (document.getElementById('bar-lora')) document.getElementById('bar-lora').style.width = `${Math.max(10, Math.min(100, 130 + Number(lRssi)))}%`;

            // 5. Logika Otomatis Relay & Peta
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
                    playBeep(1000, 'sine', 0.4, 0.1); let msg = new SpeechSynthesisUtterance("Perhatian. Debit air telah surut. Kondisi markas kembali aman."); msg.lang = 'id-ID'; window.speechSynthesis.speak(msg); addLog('SYS', '🔈 NOTIFIKASI: KONDISI KEMBALI AMAN.');
                }
            }
            if (systemBooted) { previousStatus = data.status; }

            let persentaseRisiko = Math.min(Math.round((data.water_level / 150) * 100), 100);
            document.getElementById('txt-risiko').innerText = `${persentaseRisiko}%`;
            document.getElementById('bar-risiko').style.width = `${persentaseRisiko}%`;
            if (document.getElementById('top-risiko')) document.getElementById('top-risiko').innerText = `${persentaseRisiko}%`;

            let statusHtml = ''; let dotColor = '#0ea5e9'; let cAir = document.getElementById('card-air'); let cStat = document.getElementById('card-status');
            cAir.className = 'widget-card glass-panel'; cStat.className = 'widget-card glass-panel'; 

            if (data.status === 'AMAN') { document.body.classList.remove('danger-mode'); statusHtml = `<span class="badge bg-aman">SECURE</span>`; cAir.style.borderColor = 'var(--glass-border)'; cStat.style.borderColor = 'var(--glass-border)'; dotColor = '#10b981'; document.getElementById('bar-risiko').style.background = 'var(--aman)'; markerUtama.setIcon(iconAman); markerHulu.setIcon(iconWaspada); markerHilir.setIcon(iconAman); fluidColor = 'rgba(16, 185, 129, 0.4)'; } 
            else if (data.status === 'WASPADA') { document.body.classList.remove('danger-mode'); statusHtml = `<span class="badge bg-waspada">WARNING</span>`; cAir.style.borderColor = 'var(--waspada)'; cStat.style.borderColor = 'var(--waspada)'; dotColor = '#f59e0b'; document.getElementById('bar-risiko').style.background = 'var(--waspada)'; markerUtama.setIcon(iconWaspada); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconWaspada); fluidColor = 'rgba(245, 158, 11, 0.4)'; } 
            else if (data.status === 'BAHAYA') { document.body.classList.add('danger-mode'); statusHtml = `<span class="badge bg-bahaya">CRITICAL EVAC!</span>`; cAir.style.borderColor = 'var(--bahaya)'; cStat.style.borderColor = 'var(--bahaya)'; dotColor = '#ef4444'; document.getElementById('bar-risiko').style.background = 'var(--bahaya)'; markerUtama.setIcon(iconBahaya); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconBahaya); fluidColor = 'rgba(239, 68, 68, 0.4)'; }
            
            document.getElementById('teks-status').innerHTML = statusHtml; playVoiceAlarm(data.status);
            if (window.lastTimestamp !== data.timestamp) { addLog(data.status === 'BAHAYA' ? 'ERR' : 'DAT', `⬇️ CLOUD PUSH: W=${data.water_level}cm | Solar=${sV}V | Batt=${bV}V`); window.lastTimestamp = data.timestamp; }

            let labels = globalHistory.map(item => item.timestamp); 
            let actualData = globalHistory.map(item => item.water_level);
            labels.push("T+1", "T+2");
            let predData = new Array(globalHistory.length - 1).fill(null);
            
            if(globalHistory.length >= 2) {
                let p1 = globalHistory[globalHistory.length-2].water_level; let p2 = currentWaterLevel;
                let momentum = p2 - p1; let f1 = p2 + momentum; let f2 = p2 + (momentum * 2);
                if(f1 < 0) f1 = 0; if(f2 < 0) f2 = 0;
                predData.push(p2, f1, f2);
            } else { predData.push(currentWaterLevel, currentWaterLevel, currentWaterLevel); }

            waterChart.data.labels = labels; 
            waterChart.data.datasets[0].data = actualData; 
            waterChart.data.datasets[0].borderColor = dotColor; waterChart.data.datasets[0].pointBackgroundColor = dotColor;
            waterChart.data.datasets[1].data = predData;

            let newGrad = ctx.createLinearGradient(0, 0, 0, 250);
            if(data.status === 'BAHAYA') { newGrad.addColorStop(0, 'rgba(239, 68, 68, 0.5)'); newGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); }
            else if(data.status === 'WASPADA') { newGrad.addColorStop(0, 'rgba(245, 158, 11, 0.5)'); newGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)'); }
            else { newGrad.addColorStop(0, 'rgba(14, 165, 233, 0.3)'); newGrad.addColorStop(1, 'rgba(14, 165, 233, 0.0)'); }
            waterChart.data.datasets[0].backgroundColor = newGrad; waterChart.update();
            
            // 6. Update Tabel Lengkap (Air, Flow, Suhu, Solar, Baterai, LoRa, Status)
            let tableHTML = '';
            [...globalHistory].reverse().slice(0, 20).forEach(item => { 
                let ws = item.status === 'BAHAYA' ? '#ef4444' : (item.status === 'WASPADA' ? '#f59e0b' : '#10b981'); 
                let itemFlow  = item.flow_rate_lpm !== undefined ? `${Number(item.flow_rate_lpm).toFixed(1)} L/m` : '0.0 L/m';
                let itemSolar = item.solar_v !== undefined ? `${Number(item.solar_v).toFixed(2)}V (${Number(item.solar_i ?? 0).toFixed(0)}mA)` : '0.00V (0mA)';
                let itemBatt  = item.batt_v !== undefined ? `${Number(item.batt_v).toFixed(2)}V (${item.batt_pct ?? 92}%)` : '0.00V (92%)';
                let itemLora  = item.lora_rssi !== undefined ? `${item.lora_rssi} dBm` : '-78 dBm';
                tableHTML += `<tr>
                    <td>${item.timestamp}</td>
                    <td><b>${item.water_level} cm</b></td>
                    <td>${itemFlow}</td>
                    <td>${item.temperature} °C</td>
                    <td style="color:#facc15;">${itemSolar}</td>
                    <td style="color:#10b981;">${itemBatt}</td>
                    <td style="color:#0ea5e9;">${itemLora}</td>
                    <td style="color:${ws}; font-weight:bold;">${item.status}</td>
                </tr>`; 
            });
            document.getElementById('tableBody').innerHTML = tableHTML;
        }
    });
}

function downloadCSV() {
    if (!globalHistory.length) return;
    let csv = "Waktu,Node ID,Water Level (cm),Flow Rate (L/min),Temperature (C),Solar (V),Solar (mA),Battery (V),Battery (mA),Battery (%),LoRa RSSI (dBm),Status\n";
    globalHistory.forEach(r => {
        csv += `${r.timestamp},${r.device_id},${r.water_level},${r.flow_rate_lpm ?? 0},${r.temperature},${r.solar_v ?? 0},${r.solar_i ?? 0},${r.batt_v ?? 0},${r.batt_i ?? 0},${r.batt_pct ?? 92},${r.lora_rssi ?? -78},${r.status}\n`;
    });
    let blob = new Blob([csv], { type: 'text/csv' });
    let a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aegis_telemetry_full.csv';
    a.click();
}

function generatePDF() {
    const element = document.getElementById('report-area');
    html2pdf().from(element).save('AEGIS_Report.pdf');
}
