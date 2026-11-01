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

// ================= PENGATURAN IP & SERVO =================
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

window.switchSubMenu = function(menuName) {
    document.getElementById('view-overview').style.display = (menuName === 'overview') ? 'grid' : 'none';
    document.getElementById('view-power').style.display    = (menuName === 'power')    ? 'grid' : 'none';
    document.getElementById('view-logs').style.display     = (menuName === 'logs')     ? 'block' : 'none';

    document.getElementById('tab-btn-overview').classList.toggle('active', menuName === 'overview');
    document.getElementById('tab-btn-power').classList.toggle('active', menuName === 'power');
    document.getElementById('tab-btn-logs').classList.toggle('active', menuName === 'logs');
};

window.setATSMode = function(enableAuto) {
    if(userRole !== 'developer') return;
    isAutoATS = enableAuto;
    let modeStr = isAutoATS ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ ats_mode: modeStr });
    addLog('SYS', `Smart ATS diatur ke mode: ${modeStr}`);
};

window.simulateBatteryVoltage = function(simBattV) {
    if(userRole !== 'developer') return;
    // Logika simulasi (sama seperti sebelumnya, disingkat untuk fokus UI modern)
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let newChg  = (simBattV < 7.0) ? "ADAPTOR" : "SOLAR";
    if (isAutoATS) toggleChargeMode(newChg);
    
    database.ref('sensor/logs').push({
        device_id: "NODE-SIM", timestamp: timeStr, status: "AMAN",
        water_level: 0, distance_cm: 150, temperature: 28,
        flow_rate_lpm: 0, mass_flow_kgs: 0,
        solar_v: 14.2, solar_i: 300, batt_v: simBattV, batt_i: 200, batt_pct: 50,
        lora_rssi: -75, charge_mode: newChg
    });
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
    fetch(`${ESPCAM_IP}/action?go=flash`).catch(()=>{});
};

window.adjustZoom = function(delta) {
    currentCamZoom = Math.max(0.5, Math.min(3.0, currentCamZoom + delta));
    document.getElementById('espcam-stream').style.transform = `scale(${currentCamZoom})`;
};
window.resetZoom = function() {
    currentCamZoom = 1.0;
    document.getElementById('espcam-stream').style.transform = `scale(1)`;
};

let currentWaterLevel = 0;
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
                initMapsAndCharts();
                startFirebaseListeners();
            }, 100);
        }, 500);
    }, 1500);
}

function initMapsAndCharts() {
    map = L.map('map', {zoomControl: true}).setView([KALIDERES_LAT, KALIDERES_LNG], 15); 
    currentTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').addTo(map);
    L.marker([KALIDERES_LAT, KALIDERES_LNG]).addTo(map).bindPopup('NODE UTAMA');
    
    Chart.defaults.color = '#94a3b8';
    waterChart = new Chart(document.getElementById('waterChart').getContext('2d'), { type: 'line', data: { labels: [], datasets: [{ label: 'Elevasi (cm)', data: [], borderColor: '#38bdf8' }] }, options: { responsive: true, maintainAspectRatio: false } });
    powerVoltageChart = new Chart(document.getElementById('powerVoltageChart').getContext('2d'), { type: 'line', data: { labels: [], datasets: [{ label: 'Solar', data: [], borderColor: '#fbbf24' }, { label: 'Baterai', data: [], borderColor: '#34d399' }] }, options: { responsive: true, maintainAspectRatio: false } });
    powerCurrentChart = new Chart(document.getElementById('powerCurrentChart').getContext('2d'), { type: 'line', data: { labels: [], datasets: [{ label: 'Arus Solar', data: [], borderColor: '#fbbf24' }, { label: 'Arus Baterai', data: [], borderColor: '#34d399' }] }, options: { responsive: true, maintainAspectRatio: false } });
}

function startFirebaseListeners() {
    database.ref('kontrol').on('value', (snap) => {
        let c = snap.val() || {};
        relayCH1_Pump = (c.pompa === "ON");
        relayCH2_Alarm = (c.alarm === "ON");
        relayCH3_Lamp = (c.lampu === "ON");
        relayCH4_Charge = c.charge_mode || "SOLAR";
        
        document.getElementById('badge-ch1').innerText = relayCH1_Pump ? "ON" : "OFF";
        document.getElementById('badge-ch2').innerText = relayCH2_Alarm ? "ON" : "OFF";
        document.getElementById('badge-ch3').innerText = relayCH3_Lamp ? "ON" : "OFF";
        document.getElementById('badge-ch4').innerText = relayCH4_Charge;
        document.getElementById('top-charge-mode').innerText = relayCH4_Charge === "ADAPTOR" ? "🔌 ADAPTOR DC" : "☀️ SOLAR PANEL";
    });

    database.ref('sensor/logs').limitToLast(15).on('value', (snap) => {
        globalHistory = [];
        snap.forEach(child => globalHistory.push(child.val()));
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = data.water_level;
            
            document.getElementById('teks-air').innerText = currentWaterLevel;
            document.getElementById('teks-suhu').innerText = data.temperature;
            document.getElementById('teks-flow').innerText = Number(data.flow_rate_lpm||0).toFixed(2);
            document.getElementById('top-solar-v').innerText = Number(data.solar_v||0).toFixed(2);
            document.getElementById('top-batt-v').innerText = Number(data.batt_v||0).toFixed(2);
            document.getElementById('top-lora-rssi').innerText = data.lora_rssi;
            document.getElementById('teks-status').innerText = data.status;

            let labels = globalHistory.map(i => i.timestamp);
            waterChart.data.labels = labels; waterChart.data.datasets[0].data = globalHistory.map(i => i.water_level); waterChart.update();
            powerVoltageChart.data.labels = labels; powerVoltageChart.data.datasets[0].data = globalHistory.map(i => i.solar_v); powerVoltageChart.data.datasets[1].data = globalHistory.map(i => i.batt_v); powerVoltageChart.update();
            powerCurrentChart.data.labels = labels; powerCurrentChart.data.datasets[0].data = globalHistory.map(i => i.solar_i); powerCurrentChart.data.datasets[1].data = globalHistory.map(i => i.batt_i); powerCurrentChart.update();
        }
    });
}

function toggleTheme() { document.body.classList.toggle('light-mode'); }
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog');
    if(term) { term.innerHTML += `<div class="terminal-line">[${tipe}] ${pesan}</div>`; term.scrollTop = term.scrollHeight; }
}
