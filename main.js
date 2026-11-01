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

// ================= ROLE & PRESENCE SYSTEM =================
let userRole = 'viewer';
let userName = 'Guest';

function verifyLogin() {
    let uName = document.getElementById('user-name').value.trim();
    let pass  = document.getElementById('pass-input').value.toLowerCase();
    
    if (uName === "") uName = "Anonim";
    
    if (pass === 'admin' || pass === 'dev2026') {
        userRole = 'developer';
        userName = uName + " (Dev)";
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = '');
        finishLogin();
    } else if (pass === 'viewer' || pass === 'tamu') {
        userRole = 'viewer';
        userName = uName;
        document.querySelectorAll('.dev-only').forEach(el => el.style.display = 'none');
        finishLogin();
    } else {
        document.getElementById('login-error').style.display = 'block';
    }
}

function finishLogin() {
    document.getElementById('login-screen').style.opacity = '0';
    setTimeout(() => { 
        document.getElementById('login-screen').style.visibility = 'hidden'; 
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
            userListHTML += `<div>👤 ${child.val().name}</div>`;
        });
        document.getElementById('online-count').innerText = count;
        document.getElementById('online-list').innerHTML = userListHTML;
    });
}

// ================= PENGATURAN IP & STATE =================
let ESPCAM_IP  = localStorage.getItem('aegis_cam_ip')  || "http://10.78.168.1";
let ESPMAIN_IP = localStorage.getItem('aegis_main_ip') || "";

let currentCamZoom = 1.0;
let cloudPanAngle  = 90;
let cloudTiltAngle = 90;
const SERVO_STEP   = 15;

let relayCH1_Pump   = false;
let relayCH2_Alarm  = false;
let relayCH3_Lamp   = false;
let relayCH4_Charge = "SOLAR";
let isAutoATS       = true;
const ATS_CUTOVER_V = 7.0;

// ================= CFD FLUID DYNAMICS (ANIMASI AIR) =================
let currentWaterLevel = 0;
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

// ================= SUB-MENU NAV & KONTROL MANUAL (DEV ONLY) =================
window.switchSubMenu = function(menuName) {
    document.getElementById('view-overview').style.display = (menuName === 'overview') ? 'grid' : 'none';
    document.getElementById('view-power').style.display    = (menuName === 'power')    ? 'grid' : 'none';
    document.getElementById('view-logs').style.display     = (menuName === 'logs')     ? 'block' : 'none';

    document.getElementById('tab-btn-overview').classList.toggle('active', menuName === 'overview');
    document.getElementById('tab-btn-power').classList.toggle('active', menuName === 'power');
    document.getElementById('tab-btn-logs').classList.toggle('active', menuName === 'logs');

    if (menuName === 'overview' && map) setTimeout(() => { map.invalidateSize(); }, 200);
    if (menuName === 'power' && powerVoltageChart) setTimeout(() => { powerVoltageChart.resize(); powerVoltageChart.update(); powerCurrentChart.resize(); powerCurrentChart.update(); }, 150);
};

window.setATSMode = function(enableAuto) {
    if(userRole !== 'developer') return;
    isAutoATS = enableAuto;
    let modeStr = isAutoATS ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ ats_mode: modeStr });
    
    document.getElementById('btn-ats-auto').style.background = isAutoATS ? 'var(--aman)' : 'transparent';
    document.getElementById('btn-ats-auto').style.color = isAutoATS ? '#000' : 'var(--text-main)';
    document.getElementById('btn-ats-manual').style.background = !isAutoATS ? 'var(--waspada)' : 'transparent';
    document.getElementById('btn-ats-manual').style.color = !isAutoATS ? '#000' : 'var(--text-main)';
    document.getElementById('ats-mode-text').innerText = modeStr;
    document.getElementById('top-ats-stat').innerText = modeStr;
    addLog('SYS', `Smart ATS diatur ke mode: ${modeStr}`);
};

window.simulateBatteryVoltage = function(simBattV) {
    if(userRole !== 'developer') return;
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let newChg  = (simBattV < 7.0) ? "ADAPTOR" : "SOLAR";
    if (isAutoATS) toggleChargeMode(newChg);
    
    database.ref('sensor/logs').push({
        device_id: "NODE-SIM", timestamp: timeStr, status: "AMAN",
        water_level: currentWaterLevel, distance_cm: 150, temperature: 28,
        flow_rate_lpm: 0, mass_flow_kgs: 0,
        solar_v: 14.2, solar_i: 300, batt_v: simBattV, batt_i: 200, batt_pct: Math.round(((simBattV-6)/6.8)*100),
        lora_rssi: -75, charge_mode: newChg
    });
    addLog('TST', `Simulasi Aki Drop: ${simBattV}V dikirim ke Cloud.`);
};

window.moveCam = function(direction) {
    if(userRole !== 'developer') return;
    if (direction === 'left')   cloudPanAngle  = Math.min(180, cloudPanAngle + SERVO_STEP);
    if (direction === 'right')  cloudPanAngle  = Math.max(0, cloudPanAngle - SERVO_STEP);
    if (direction === 'up')     cloudTiltAngle = Math.min(180, cloudTiltAngle + SERVO_STEP);
    if (direction === 'down')   cloudTiltAngle = Math.max(0, cloudTiltAngle - SERVO_STEP);
    if (direction === 'center') { cloudPanAngle = 90; cloudTiltAngle = 90; }

    database.ref('kontrol').update({ pan: cloudPanAngle, tilt: cloudTiltAngle });
    if (ESPMAIN_IP !== "") fetch(`${ESPMAIN_IP}/servo?go=${direction}`).catch(()=>{});
};

window.toggleRelayTest = function(channel) {
    if(userRole !== 'developer') return;
    if (channel === 1) {
        relayCH1_Pump = !relayCH1_Pump;
        database.ref('kontrol').update({ pompa: relayCH1_Pump ? "ON" : "OFF" });
    } else if (channel === 2) {
        relayCH2_Alarm = !relayCH2_Alarm;
        database.ref('kontrol').update({ alarm: relayCH2_Alarm ? "ON" : "OFF" });
    } else if (channel === 3) {
        relayCH3_Lamp = !relayCH3_Lamp;
        database.ref('kontrol').update({ lampu: relayCH3_Lamp ? "ON" : "OFF" });
    }
};

window.toggleChargeMode = function(forceMode = null) {
    if(userRole !== 'developer') return;
    relayCH4_Charge = forceMode ? forceMode : (relayCH4_Charge === "SOLAR" ? "ADAPTOR" : "SOLAR");
    database.ref('kontrol').update({ charge_mode: relayCH4_Charge });
};

window.toggleFlashLED = function() {
    if(userRole !== 'developer') return;
    fetch(`${ESPCAM_IP}/action?go=flash`).then(r => r.json()).then(d => {
        const levels = ['OFF', 'LOW', 'MED', 'MAX'];
        document.getElementById('btn-flash').innerText = `💡 FLASH: ${levels[d.flash]}`;
        document.getElementById('cam-flash-badge').innerText = levels[d.flash];
    }).catch(()=>{});
};

window.adjustZoom = function(delta) {
    currentCamZoom = Math.max(0.5, Math.min(3.0, currentCamZoom + delta));
    document.getElementById('espcam-stream').style.transform = `scale(${currentCamZoom})`;
    document.getElementById('cam-zoom-label').innerText = currentCamZoom.toFixed(1) + 'x';
};
window.resetZoom = function() {
    currentCamZoom = 1.0;
    document.getElementById('espcam-stream').style.transform = `scale(1)`;
    document.getElementById('cam-zoom-label').innerText = '1.0x';
};

// ================= INISIALISASI PETA, GRAFIK & FIREBASE =================
let systemBooted = false; let globalHistory = [];
var map, waterChart, powerVoltageChart, powerCurrentChart, currentTileLayer;
const KALIDERES_LAT = -6.1044; const KALIDERES_LNG = 106.7022; 

function startBootSequence() {
    document.getElementById('boot-screen').style.visibility = 'visible'; 
    document.getElementById('boot-screen').style.opacity = '1';
    
    setTimeout(() => {
        document.getElementById('boot-screen').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('boot-screen').style.display = 'none';
            document.getElementById('dashboard-core').style.display = 'block';
            setTimeout(() => {
                document.getElementById('dashboard-core').style.opacity = '1';
                systemBooted = true;
                document.getElementById('espcam-stream').src = `${ESPCAM_IP}:81/stream`;
                document.getElementById('cam-ip-label').innerText = ESPCAM_IP.replace('http://','') + ':81';
                initMapsAndCharts();
                startFirebaseListeners();
                renderFluid();
            }, 100);
        }, 500);
    }, 1500);
}

function initMapsAndCharts() {
    map = L.map('map', {zoomControl: true}).setView([KALIDERES_LAT, KALIDERES_LNG], 15); 
    currentTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);
    L.marker([KALIDERES_LAT, KALIDERES_LNG]).addTo(map).bindPopup('NODE UTAMA KALIDERES');
    
    Chart.defaults.color = '#94a3b8'; Chart.defaults.font.family = "'JetBrains Mono', monospace";
    
    // Grafik Air
    waterChart = new Chart(document.getElementById('waterChart').getContext('2d'), { 
        type: 'line', data: { labels: [], datasets: [{ label: 'Elevasi Air (cm)', data: [], borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.2)', fill: true, tension: 0.2 }] }, 
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend:{display:false} }, scales: { y: { beginAtZero:true } } } 
    });
    
    // Grafik Daya (Volt)
    powerVoltageChart = new Chart(document.getElementById('powerVoltageChart').getContext('2d'), { 
        type: 'line', data: { labels: [], datasets: [
            { label: 'Solar Panel (V)', data: [], borderColor: '#fbbf24', tension: 0.2 }, 
            { label: 'Baterai (V)', data: [], borderColor: '#34d399', tension: 0.2 },
            { label: 'Batas Drop (7.0V)', data: [], borderColor: '#f87171', borderDash: [5,5], pointRadius: 0 }
        ] }, options: { responsive: true, maintainAspectRatio: false } 
    });

    // Grafik Daya (Arus)
    powerCurrentChart = new Chart(document.getElementById('powerCurrentChart').getContext('2d'), { 
        type: 'line', data: { labels: [], datasets: [
            { label: 'Arus Solar (mA)', data: [], borderColor: '#fbbf24', tension: 0.2 }, 
            { label: 'Arus Baterai (mA)', data: [], borderColor: '#34d399', tension: 0.2 }
        ] }, options: { responsive: true, maintainAspectRatio: false } 
    });
}

function startFirebaseListeners() {
    // 1. Pembacaan Status Aktuator Relay
    database.ref('kontrol').on('value', (snap) => {
        // Update Widget #9: Status Mitigasi (Pompa CH1, Alarm CH2, Lampu CH3)
        if (document.getElementById('top-pump-big')) {
            const pBig = document.getElementById('top-pump-big');
            pBig.innerText = relayCH1_Pump ? "🚰 POMPA: AKTIF" : "POMPA: STANDBY";
            pBig.style.color = relayCH1_Pump ? "var(--primary)" : "var(--text-muted)";
        }
        if (document.getElementById('top-alarm-stat')) {
            const aSt = document.getElementById('top-alarm-stat');
            aSt.innerText = relayCH2_Alarm ? "ON" : "OFF";
            aSt.style.color = relayCH2_Alarm ? "var(--bahaya)" : "var(--text-muted)";
        }
        if (document.getElementById('top-lamp-stat')) {
            const lSt = document.getElementById('top-lamp-stat');
            lSt.innerText = relayCH3_Lamp ? "ON" : "OFF";
            lSt.style.color = relayCH3_Lamp ? "var(--waspada)" : "var(--text-muted)";
        }
        let c = snap.val() || {};
        relayCH1_Pump = (c.pompa === "ON");
        relayCH2_Alarm = (c.alarm === "ON");
        relayCH3_Lamp = (c.lampu === "ON");
        relayCH4_Charge = c.charge_mode || "SOLAR";
        isAutoATS = (c.ats_mode === "AUTO" || c.ats_mode === undefined);
        
        // Update Tampilan Tombol/Badge Dev
        if(document.getElementById('badge-ch1')) document.getElementById('badge-ch1').innerText = relayCH1_Pump ? "ON" : "OFF";
        if(document.getElementById('badge-ch2')) document.getElementById('badge-ch2').innerText = relayCH2_Alarm ? "ON" : "OFF";
        if(document.getElementById('badge-ch3')) document.getElementById('badge-ch3').innerText = relayCH3_Lamp ? "ON" : "OFF";
        if(document.getElementById('badge-ch4')) document.getElementById('badge-ch4').innerText = relayCH4_Charge;
        
        // Update Panel ATS & Widget Atas
        document.getElementById('ats-curr-source').innerText = relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR" : "☀️ SOLAR";
        document.getElementById('ats-curr-source').style.color = relayCH4_Charge === "ADAPTOR" ? "#a855f7" : "var(--primary)";
        document.getElementById('top-charge-mode').innerText = relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR DC" : "☀️ SOLAR PANEL";
        document.getElementById('top-charge-mode').style.color = relayCH4_Charge === "ADAPTOR" ? "#a855f7" : "var(--aman)";
        document.getElementById('top-ats-stat').innerText = isAutoATS ? "AUTO" : "MANUAL";
    });

    // 2. Pembacaan Sensor Telemetri Keseluruhan (Air, Suhu, Solar, Baterai, LoRa)
    database.ref('sensor/logs').limitToLast(15).on('value', (snap) => {
        globalHistory = [];
        snap.forEach(child => globalHistory.push(child.val()));
        
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = data.water_level || 0;
            
            // Tangkap IP ESP Utama jika ada
            if (data.node_ip && data.node_ip !== "" && ESPMAIN_IP !== `http://${data.node_ip}`) {
                ESPMAIN_IP = `http://${data.node_ip}`;
                localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
                addLog('SYS', `IP Node ESP32 Utama diperbarui: ${ESPMAIN_IP}`);
            }

            // Update Angka Widget Kartu Atas
            document.getElementById('teks-air').innerText = currentWaterLevel;
            document.getElementById('top-jarak').innerText = Number(data.distance_cm || Math.max(0, 150 - currentWaterLevel)).toFixed(1);
            document.getElementById('teks-suhu').innerText = data.temperature || "0.0";
            document.getElementById('teks-flow').innerText = Number(data.flow_rate_lpm || 0).toFixed(2);
            document.getElementById('top-mass').innerText = Number(data.mass_flow_kgs || 0).toFixed(2);
            document.getElementById('top-solar-v').innerText = Number(data.solar_v || 0).toFixed(2);
            document.getElementById('top-solar-i').innerText = Number(data.solar_i || 0).toFixed(0);
            document.getElementById('top-solar-p').innerText = Number(data.solar_p || 0).toFixed(0);
            
            let bV = Number(data.batt_v || 0).toFixed(2);
            document.getElementById('top-batt-v').innerText = bV;
            document.getElementById('top-batt-i').innerText = Number(data.batt_i || 0).toFixed(0);
            document.getElementById('top-batt-pct').innerText = (data.batt_pct || 92) + "%";
            document.getElementById('ats-curr-batt').innerText = bV + " V";
            
            // Peringatan Merah jika Aki di bawah 7V
            if(Number(bV) > 0 && Number(bV) < 7.0) {
                document.getElementById('ats-curr-batt').style.color = "var(--bahaya)";
                document.getElementById('card-batt').style.borderColor = "var(--bahaya)";
            } else {
                document.getElementById('ats-curr-batt').style.color = "var(--aman)";
                document.getElementById('card-batt').style.borderColor = "rgba(16, 185, 129, 0.35)";
            }

            document.getElementById('top-lora-rssi').innerText = data.lora_rssi || -78;
            document.getElementById('teks-status').innerText = data.status || "AMAN";
            
            // Ganti warna teks status & fluid
            let sHtml = '';
            if (data.status === 'AMAN') { sHtml = `<span class="badge bg-aman">SECURE</span>`; fluidColor = 'rgba(52, 211, 153, 0.4)'; }
            else if (data.status === 'WASPADA') { sHtml = `<span class="badge bg-waspada">WARNING</span>`; fluidColor = 'rgba(251, 191, 36, 0.4)'; }
            else if (data.status === 'BAHAYA') { sHtml = `<span class="badge bg-bahaya">CRITICAL EVAC</span>`; fluidColor = 'rgba(248, 113, 113, 0.4)'; }
            document.getElementById('teks-status').innerHTML = sHtml;
            document.getElementById('top-risiko').innerText = Math.min(Math.round((currentWaterLevel/150)*100), 100) + "%";

            // Update Grafik (Chart.js)
            let labels = globalHistory.map(i => i.timestamp);
            waterChart.data.labels = labels; 
            waterChart.data.datasets[0].data = globalHistory.map(i => i.water_level); 
            waterChart.update();
            
            powerVoltageChart.data.labels = labels; 
            powerVoltageChart.data.datasets[0].data = globalHistory.map(i => i.solar_v); 
            powerVoltageChart.data.datasets[1].data = globalHistory.map(i => i.batt_v); 
            powerVoltageChart.data.datasets[2].data = new Array(labels.length).fill(7.0); // Garis batas 7.0V
            powerVoltageChart.update();
            
            powerCurrentChart.data.labels = labels; 
            powerCurrentChart.data.datasets[0].data = globalHistory.map(i => i.solar_i); 
            powerCurrentChart.data.datasets[1].data = globalHistory.map(i => i.batt_i); 
            powerCurrentChart.update();

            // Update Tabel Lengkap (Sub-Menu 3)
            let fullTableHTML = '';
            [...globalHistory].reverse().forEach(item => {
                let ws = item.status === 'BAHAYA' ? 'var(--bahaya)' : (item.status === 'WASPADA' ? 'var(--waspada)' : 'var(--aman)'); 
                let chg = item.charge_mode || "SOLAR";
                fullTableHTML += `<tr>
                    <td>${item.timestamp}</td>
                    <td><b>${item.water_level} cm</b></td>
                    <td>${Number(item.distance_cm || 0).toFixed(1)} cm</td>
                    <td>${Number(item.flow_rate_lpm || 0).toFixed(1)} L/m</td>
                    <td>${item.temperature} °C</td>
                    <td style="color:#fbbf24;">${Number(item.solar_v||0).toFixed(1)}V / ${Number(item.solar_i||0).toFixed(0)}mA</td>
                    <td style="color:#34d399;">${Number(item.batt_v||0).toFixed(1)}V / ${item.batt_pct||92}%</td>
                    <td style="color:${chg === 'ADAPTOR' ? '#a855f7' : '#34d399'}; font-weight:bold;">${chg}</td>
                    <td style="color:var(--primary);">${item.lora_rssi || -78} dBm</td>
                    <td style="color:${ws}; font-weight:bold;">${item.status}</td>
                </tr>`;
            });
            document.getElementById('fullTableBody').innerHTML = fullTableHTML;
        }
    });
}

// ================= UTILITIES =================
function toggleTheme() { document.body.classList.toggle('light-mode'); }
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog');
    if(term) { term.innerHTML += `<div class="terminal-line"><span style="color:var(--text-muted);">${new Date().toLocaleTimeString('id-ID')}</span> [${tipe}] ${pesan}</div>`; term.scrollTop = term.scrollHeight; }
}
function toggleDeck() { document.getElementById('control-deck').classList.toggle('open'); }
function updateSimValue(val) { document.getElementById('sim-val').innerText = val; }
function pushSimData(val) {
    if(userRole !== 'developer') return;
    let stat = val >= 100 ? "BAHAYA" : (val >= 70 ? "WASPADA" : "AMAN");
    database.ref('sensor/logs').push({
        device_id: "NODE-SIM-1", timestamp: new Date().toLocaleTimeString('id-ID', {hour12:false}),
        status: stat, water_level: Number(val), distance_cm: 150-Number(val), temperature: 28.5,
        solar_v: 14.2, batt_v: 12.4
    });
}
function changeCamIPPrompt() {
    if(userRole !== 'developer') return;
    let ip = prompt("Masukkan IP Kamera:", ESPCAM_IP.replace('http://',''));
    if(ip && ip.trim()!=="") { ESPCAM_IP = `http://${ip.replace('http://','').replace(':81/stream','')}`; localStorage.setItem('aegis_cam_ip', ESPCAM_IP); }
}
function toggleMapLayer() {
    isSatelliteMode = !isSatelliteMode; map.removeLayer(currentTileLayer);
    currentTileLayer = L.tileLayer(isSatelliteMode ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    document.getElementById('btn-map-mode').innerText = isSatelliteMode ? '🗺️ JALAN' : '🛰️ SATELIT';
}
function centerMap() { map.setView([KALIDERES_LAT, KALIDERES_LNG], 15); }
function toggleFullscreenCam() { document.getElementById('cctv-feed').requestFullscreen().catch(()=>{}); }
function downloadCSV() { /* Sama seperti kode eksisting */ }
function generatePDF() { html2pdf().from(document.getElementById('report-area')).save('AEGIS_Report.pdf'); }
setInterval(() => { 
    const now = new Date(); document.getElementById('teks-jam').innerText = now.toLocaleTimeString('id-ID', { hour12: false }); 
    document.getElementById('teks-tanggal').innerText = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase(); 
}, 1000);
