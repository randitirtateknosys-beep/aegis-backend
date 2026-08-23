// ==========================================
// FIREBASE CONFIGURATION INJECTION
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyDnqlbMx-UMFP3MHG_6tUM50NlPsPzsuzw",
    authDomain: "aegis-kalideres.firebaseapp.com",
    databaseURL: "https://aegis-kalideres-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "aegis-kalideres",
    storageBucket: "aegis-kalideres.firebasestorage.app",
    messagingSenderId: "928229188111",
    appId: "1:928229188111:web:4fc633bc2a1f102350797a"
};
// ==========================================

// Initialize Firebase
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const database = firebase.database();

// Variabel Global
let currentWaterLevel = 0; let currentStatus = "AMAN";
let isPumpActive = false; let alarmPlaying = false;
let systemBooted = false; let globalHistory = [];

// UI SOUND EFFECTS
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq = 800, type = 'sine', duration = 0.1, vol = 0.05) {
    if(audioCtx.state === 'suspended') audioCtx.resume();
    let osc = audioCtx.createOscillator(); let gain = audioCtx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime); gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + duration);
}
document.querySelectorAll('.btn-sfx').forEach(btn => { btn.addEventListener('click', () => playBeep(1200, 'square', 0.1)); });

// LOGIN & BOOT SEQUENCE (PASSWORD: admin)
document.getElementById('pass-input').addEventListener('keypress', function(e) { if(e.key === 'Enter') verifyLogin(); });
function verifyLogin() {
    let pass = document.getElementById('pass-input').value.toLowerCase();
    if(pass === 'admin' || pass === 'aegis2026') {
        playBeep(1000, 'square', 0.2, 0.1); document.getElementById('login-screen').style.opacity = '0';
        setTimeout(() => { document.getElementById('login-screen').style.visibility = 'hidden'; startBootSequence(); }, 1000);
    } else {
        playBeep(200, 'sawtooth', 0.3, 0.1); document.getElementById('login-error').style.display = 'block'; document.getElementById('pass-input').value = '';
    }
}

function startBootSequence() {
    document.getElementById('boot-screen').style.visibility = 'visible'; document.getElementById('boot-screen').style.opacity = '1';
    const bootLog = document.getElementById('boot-log');
    const messages = [ "> AUTHENTICATION ACCEPTED...", "> MENGHUBUNGKAN KE FIREBASE WEBSOCKET...", "> SECURE CONNECTION ESTABLISHED (ASIA-SOUTHEAST1)...", "> MEMUAT MODUL GEOSPASIAL...", "> MENGKALIBRASI SENSOR LORA NODE-1...", "> SISTEM A.E.G.I.S CLOUD SIAP." ];
    let i = 0;
    let bootInterval = setInterval(() => {
        if(i < messages.length) { bootLog.innerHTML += messages[i] + "<br>"; playBeep(400 + (i*100), 'square', 0.05, 0.02); i++; } 
        else {
            clearInterval(bootInterval);
            setTimeout(() => {
                playBeep(1500, 'sine', 0.3, 0.1); document.getElementById('boot-screen').style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('boot-screen').style.visibility = 'hidden';
                    document.getElementById('dashboard-core').style.display = 'block';
                    setTimeout(() => { document.getElementById('dashboard-core').style.opacity = '1'; systemBooted = true; initMapsAndCharts(); startFirebaseListeners(); }, 100);
                }, 1000);
            }, 500);
        }
    }, 400);
}

// TEMA, MIC, & HUJAN
let isLightMode = false; var mapTilesDark = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'; var mapTilesLight = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'; var currentTileLayer; var map, waterChart, routingControl;
function toggleTheme() {
    isLightMode = !isLightMode; document.body.classList.toggle('light-mode'); let btn = document.getElementById('btn-theme');
    if(isLightMode) { btn.innerHTML = '🌙 GELAP'; map.removeLayer(currentTileLayer); currentTileLayer = L.tileLayer(mapTilesLight).addTo(map); Chart.defaults.color = '#64748b'; Chart.defaults.borderColor = 'rgba(0,0,0,0.1)'; addLog('SYS', 'UI Light Mode Aktif'); } 
    else { btn.innerHTML = '🌞 TERANG'; map.removeLayer(currentTileLayer); currentTileLayer = L.tileLayer(mapTilesDark).addTo(map); Chart.defaults.color = '#94a3b8'; Chart.defaults.borderColor = 'rgba(14,165,233,0.1)'; addLog('SYS', 'UI Dark Mode Aktif'); }
    waterChart.update();
}

let aiListening = false; const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition; const recognition = SpeechRecognition ? new SpeechRecognition() : null;
if(recognition) {
    recognition.lang = 'id-ID'; recognition.continuous = false;
    recognition.onresult = function(e) {
        const perintah = e.results[0][0].transcript.toLowerCase(); addLog('AI', `In: "${perintah}"`);
        let jawaban = "Instruksi tidak dikenali.";
        if(perintah.includes('air') || perintah.includes('banjir')) { jawaban = `Tinggi air saat ini ${currentWaterLevel} sentimeter. Status: ${currentStatus}.`; } 
        else if(perintah.includes('cuaca')) { jawaban = `Radar mendeteksi cuaca Kalideres saat ini ${document.getElementById('teks-cuaca').innerText}.`; } 
        else if(perintah.includes('pompa')) { jawaban = isPumpActive ? "Pompa penguras sedang beroperasi penuh." : "Mesin pompa dalam keadaan mati."; }
        addLog('AI', `Out: "${jawaban}"`); let msg = new SpeechSynthesisUtterance(jawaban); msg.lang = 'id-ID'; msg.pitch = 1.1; window.speechSynthesis.speak(msg); toggleVoiceAI(true);
    };
    recognition.onerror = function() { toggleVoiceAI(true); }; recognition.onend = function() { if(aiListening) toggleVoiceAI(true); }
}
function toggleVoiceAI(forceOff = false) {
    if(!recognition) return; let btn = document.getElementById('btn-ai'); let txt = document.getElementById('ai-text');
    try {
        if(aiListening || forceOff) { recognition.stop(); aiListening = false; btn.classList.remove('listening'); txt.innerText = "AI ASSISTANT"; } 
        else { recognition.start(); aiListening = true; btn.classList.add('listening'); txt.innerText = "LISTENING..."; let msg = new SpeechSynthesisUtterance("Sistem siap."); msg.lang = 'id-ID'; window.speechSynthesis.speak(msg); }
    } catch (e) {}
}

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
        playBeep(2000, 'square', 0.5, 0.1); let msg = new SpeechSynthesisUtterance("Peringatan kritis! Level air melampaui batas toleransi! Menjalankan protokol evakuasi Kampung Sawah Mede sekarang! Pompa mitigasi telah diaktifkan."); msg.lang = 'id-ID'; window.speechSynthesis.speak(msg); alarmPlaying = true;
    } else if (status !== 'BAHAYA') { alarmPlaying = false; }
}

setInterval(() => { const now = new Date(); document.getElementById('teks-jam').innerText = now.toLocaleTimeString('id-ID', { hour12: false }); document.getElementById('teks-tanggal').innerText = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase(); }, 1000);
function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog'); let time = new Date().toLocaleTimeString('id-ID', { hour12: false }); 
    let clr = tipe === 'ERR' ? '#ef4444' : (tipe === 'AI' ? '#a855f7' : (tipe==='NET' ? '#10b981' : (tipe==='CMD' ? '#facc15' : '#0ea5e9')));
    term.innerHTML += `<div class="terminal-line"><span style="color:#64748b; width:65px;">${time}</span> <span style="color:${clr}; font-weight:bold; width:50px;">[${tipe}]</span> <span style="color:var(--text-main);">${pesan}</span></div>`; term.scrollTop = term.scrollHeight;
}

// TERMINAL -> FIREBASE DUAL-WAY SYNC
document.getElementById('cmd-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        let cmd = this.value.toLowerCase().trim(); this.value = ''; addLog('CMD', `> ${cmd}`); playBeep(900, 'square', 0.05); 
        
        if(cmd === 'help') { addLog('SYS', 'Command: [ clear, pump on, pump off, matrix ]'); } 
        else if(cmd === 'clear') { document.getElementById('terminalLog').innerHTML = ''; } 
        else if(cmd === 'pump on') {
            database.ref('kontrol/pompa').set("ON"); // TULIS KE FIREBASE CLOUD
            addLog('NET', 'MENGIRIM PERINTAH POMPA "ON" KE FIREBASE...');
        } else if(cmd === 'pump off') {
            database.ref('kontrol/pompa').set("OFF"); // TULIS KE FIREBASE CLOUD
            addLog('NET', 'MENGIRIM PERINTAH POMPA "OFF" KE FIREBASE...');
        } else if(cmd === 'matrix') {
            document.body.style.backgroundImage = "url('https://i.gifer.com/XOsX.gif')"; addLog('SYS', 'ENTERING THE MATRIX...');
        } else if(cmd !== '') { addLog('ERR', `Command '${cmd}' tidak ditemukan.`); }
    }
});

// INIT MAPS & CHARTS
let markerUtama, markerHulu, markerHilir, markerPosko;
const KALIDERES_LAT = -6.1044; const KALIDERES_LNG = 106.7022; 
const POSKO_LAT = -6.1015; const POSKO_LNG = 106.7085; 
const HULU_LAT = -6.1150; const HULU_LNG = 106.6950; const HILIR_LAT = -6.0950; const HILIR_LNG = 106.7150;

function initMapsAndCharts() {
    map = L.map('map', {zoomControl: false}).setView([KALIDERES_LAT, KALIDERES_LNG], 14); 
    currentTileLayer = L.tileLayer(mapTilesDark, { attribution: 'A.E.G.I.S Mapping' }).addTo(map);
    markerHulu = L.circleMarker([HULU_LAT, HULU_LNG], { color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.5, radius: 6 }).addTo(map).bindPopup('NODE HULU');
    markerUtama = L.circleMarker([KALIDERES_LAT, KALIDERES_LNG], { color: '#0ea5e9', fillColor: '#0ea5e9', fillOpacity: 0.8, radius: 10 }).addTo(map);
    markerHilir = L.circleMarker([HILIR_LAT, HILIR_LNG], { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.5, radius: 6 }).addTo(map).bindPopup('NODE HILIR');
    
    var shelterIcon = L.divIcon({className: 'shelter-icon', html: '🏥', iconSize: [30,30]});
    markerPosko = L.marker([POSKO_LAT, POSKO_LNG], {icon: shelterIcon}).addTo(map);
    markerPosko.bindPopup('<div style="text-align:center; font-family:monospace;"><b style="font-size:14px; color:white; display:block; margin-bottom:5px;">SECURE ZONE</b>POSKO KEL. KAMAL</div>', {className: 'evakuasi-popup', closeButton: false, autoClose: false, closeOnClick: false});
    
    routingControl = L.Routing.control({ waypoints: [ L.latLng(KALIDERES_LAT, KALIDERES_LNG), L.latLng(POSKO_LAT, POSKO_LNG) ], routeWhileDragging: false, addWaypoints: false, fitSelectedRoutes: true, show: false, createMarker: function() { return null; }, lineOptions: { styles: [{color: '#10b981', opacity: 1, weight: 5, className: 'animate-route'}] } });

    Chart.defaults.color = '#64748b'; Chart.defaults.borderColor = 'rgba(14,165,233,0.1)'; Chart.defaults.font.family = "'Courier New', Courier, monospace";
    ctx = document.getElementById('waterChart').getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, 250); grad.addColorStop(0, 'rgba(14, 165, 233, 0.4)'); grad.addColorStop(1, 'rgba(14, 165, 233, 0.0)');
    waterChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'LVL(CM)', data: [], borderColor: '#0ea5e9', backgroundColor: grad, borderWidth: 2, fill: true, tension: 0.2, pointRadius: 2, pointBackgroundColor: '#0ea5e9' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, suggestedMax: 150 }, x: { grid: { display: false } } } } });

    fetchWeather(); setInterval(fetchWeather, 300000);
}

setInterval(() => { if(systemBooted){ let lora = -75 - Math.floor(Math.random() * 15); document.getElementById('txt-lora').innerText = `${lora} dBm`; document.getElementById('bar-lora').style.width = `${100 + lora + 30}%`; } }, 5000);

async function fetchWeather() {
    if(!systemBooted) return;
    try {
        let res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${KALIDERES_LAT}&longitude=${KALIDERES_LNG}&current_weather=true`); let d = (await res.json()).current_weather.weathercode;
        let n = "CERAH", i = "☀️"; if(isRaining) { isRaining = false; canvas.style.opacity = 0; particles = []; }
        if(d >= 1 && d <= 3) { n = "BERAWAN"; i = "⛅"; } else if(d >= 51) { n = d>=80 ? "BADAI HUJAN" : "HUJAN LOKAL"; i = d>=80 ? "⛈️" : "🌧️"; isRaining = true; createRain(); canvas.style.opacity = 1; drawRain(); }
        document.getElementById('teks-cuaca').innerText = n; document.getElementById('ikon-cuaca').innerText = i;
    } catch(e) {}
}

function runAIForecast(historyArray) {
    if(historyArray.length < 5) return; let recent = historyArray.slice(-5); let slope = (recent[recent.length-1].water_level - recent[0].water_level) / 5; 
    let forecastEl = document.getElementById('txt-forecast'); forecastEl.classList.remove('danger');
    if(slope > 1.5) { 
        let timeToLimit = Math.round((100 - recent[recent.length-1].water_level) / slope); 
        if(timeToLimit > 0) { forecastEl.innerHTML = `⚠️ AI PREDIKSI: MELUAP DALAM ${timeToLimit} MNT`; forecastEl.classList.add('danger'); } else { forecastEl.innerHTML = `🚨 AI: KAPASITAS TERLAMPAUI`; forecastEl.classList.add('danger'); }
    } else if(slope > 0) { forecastEl.innerHTML = `AI PREDIKSI: DEBIT NAIK STABIL`; forecastEl.style.color = 'var(--waspada)';
    } else { forecastEl.innerHTML = `AI PREDIKSI: DEBIT AMAN`; forecastEl.style.color = 'var(--primary)'; }
}

// ========================================================
// 🚀 FIREBASE WEBSOCKET LISTENERS (THE MAGIC HAPPENS HERE)
// ========================================================
function startFirebaseListeners() {
    
    // 1. MENDENGAR PERINTAH POMPA DARI CLOUD / ESP32
    database.ref('kontrol/pompa').on('value', (snapshot) => {
        let val = snapshot.val();
        if (val === "ON" || val === "MENYALA") {
            isPumpActive = true;
            document.getElementById('pump-icon').classList.add('active'); document.getElementById('flow-bar').classList.add('active');
            document.getElementById('pump-status-text').innerText = 'CLOUD OVERRIDE (MAX)'; document.getElementById('pump-status-text').style.color = '#fff';
            addLog('NET', '⬇️ POMPA DIAKTIFKAN VIA CLOUD.');
        } else {
            isPumpActive = false;
            document.getElementById('pump-icon').classList.remove('active'); document.getElementById('flow-bar').classList.remove('active');
            document.getElementById('pump-status-text').innerText = 'STANDBY'; document.getElementById('pump-status-text').style.color = 'var(--text-muted)';
            addLog('NET', '⬇️ POMPA DIMATIKAN VIA CLOUD.');
        }
    });

    // 2. MENDENGAR DATA SENSOR DARI ESP32 SECARA REAL-TIME (MAX 30 DATA TERAKHIR)
    database.ref('sensor/logs').limitToLast(30).on('value', (snapshot) => {
        globalHistory = [];
        snapshot.forEach(child => { globalHistory.push(child.val()); });
        
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1]; 
            currentWaterLevel = data.water_level; currentStatus = data.status;
            
            document.getElementById('teks-air').innerText = currentWaterLevel; document.getElementById('teks-suhu').innerText = data.temperature;
            runAIForecast(globalHistory);

            // LOGIKA EVAKUASI & OTOMASI POMPA
            if (data.status === 'BAHAYA' && !isPumpActive) {
                routingControl.addTo(map); markerPosko.openPopup(); map.setView([KALIDERES_LAT, KALIDERES_LNG], 14);
                database.ref('kontrol/pompa').set("ON"); // Auto trigger pompa ke cloud
                addLog('SYS', '🚨 LIMIT BAHAYA! PROTOKOL EVAKUASI & POMPA AKTIF.');
            } else if (data.status === 'AMAN' && isPumpActive) {
                map.removeControl(routingControl); markerPosko.closePopup();
                database.ref('kontrol/pompa').set("OFF"); // Auto matikan pompa ke cloud
                addLog('SYS', '✅ DEBIT AMAN. PROTOKOL DIHENTIKAN.');
            }

            // DIAGNOSTIK
            let persentaseRisiko = Math.min(Math.round((data.water_level / 150) * 100), 100);
            document.getElementById('txt-risiko').innerText = `${persentaseRisiko}%`; document.getElementById('bar-risiko').style.width = `${persentaseRisiko}%`;

            if(data.status === 'BAHAYA') { markerHulu.setStyle({color: '#ef4444', fillColor: '#ef4444'}); markerHilir.setStyle({color: '#f59e0b', fillColor: '#f59e0b'}); } 
            else { markerHulu.setStyle({color: '#10b981', fillColor: '#10b981'}); markerHilir.setStyle({color: '#10b981', fillColor: '#10b981'}); }

            let statusHtml = ''; let dotColor = '#0ea5e9';
            let cAir = document.getElementById('card-air'); let cStat = document.getElementById('card-status');
            cAir.className = 'widget-card glass-panel'; cStat.className = 'widget-card glass-panel'; 

            if (data.status === 'AMAN') {
                document.body.classList.remove('danger-mode'); statusHtml = `<span class="badge bg-aman">SECURE</span>`; cAir.style.borderColor = 'var(--glass-border)'; cStat.style.borderColor = 'var(--glass-border)'; dotColor = '#10b981'; document.getElementById('bar-risiko').style.background = 'var(--aman)';
            } else if (data.status === 'WASPADA') {
                document.body.classList.remove('danger-mode'); statusHtml = `<span class="badge bg-waspada">WARNING</span>`; cAir.style.borderColor = 'var(--waspada)'; cStat.style.borderColor = 'var(--waspada)'; dotColor = '#f59e0b'; document.getElementById('bar-risiko').style.background = 'var(--waspada)';
            } else if (data.status === 'BAHAYA') {
                document.body.classList.add('danger-mode'); statusHtml = `<span class="badge bg-bahaya">CRITICAL EVAC!</span>`; cAir.style.borderColor = 'var(--bahaya)'; cStat.style.borderColor = 'var(--bahaya)'; dotColor = '#ef4444'; document.getElementById('bar-risiko').style.background = 'var(--bahaya)';
            }
            document.getElementById('teks-status').innerHTML = statusHtml;

            playVoiceAlarm(data.status); markerUtama.setStyle({ color: dotColor, fillColor: dotColor });
            
            addLog(data.status === 'BAHAYA' ? 'ERR' : 'DAT', `⬇️ PUSH DARI ESP32: W=${data.water_level}cm T=${data.temperature}C`); 

            // GRAFIK & TABEL
            let labels = globalHistory.map(item => item.timestamp); let chartData = globalHistory.map(item => item.water_level);
            waterChart.data.labels = labels; waterChart.data.datasets[0].data = chartData; waterChart.data.datasets[0].borderColor = dotColor; waterChart.data.datasets[0].pointBackgroundColor = dotColor;
            
            let newGrad = ctx.createLinearGradient(0, 0, 0, 250);
            if(data.status === 'BAHAYA') { newGrad.addColorStop(0, 'rgba(239, 68, 68, 0.5)'); newGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); }
            else if(data.status === 'WASPADA') { newGrad.addColorStop(0, 'rgba(245, 158, 11, 0.5)'); newGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)'); }
            else { newGrad.addColorStop(0, 'rgba(14, 165, 233, 0.3)'); newGrad.addColorStop(1, 'rgba(14, 165, 233, 0.0)'); }
            waterChart.data.datasets[0].backgroundColor = newGrad; waterChart.update();
            
            let tableHTML = '';
            [...globalHistory].reverse().slice(0, 20).forEach(item => {
                let ws = item.status === 'BAHAYA' ? '#ef4444' : (item.status === 'WASPADA' ? '#f59e0b' : '#10b981');
                tableHTML += `<tr><td>${item.timestamp}</td><td><span style="color:#0ea5e9;">${item.device_id}</span></td><td><b>${item.water_level}</b></td><td>${item.temperature}</td><td style="color:${ws}; font-weight:bold;">${item.status}</td></tr>`;
            });
            document.getElementById('tableBody').innerHTML = tableHTML;
        }
    });
}

function downloadCSV() {
    if(globalHistory.length === 0) {
        addLog('ERR', 'Data belum tersedia di Firebase untuk diunduh.');
        return;
    }
    let csv = "data:text/csv;charset=utf-8,Waktu,Lokasi,Tinggi Air,Suhu,Status\n";
    globalHistory.forEach(r => { csv += `${r.timestamp},Kp.Sawah Mede,${r.water_level},${r.temperature},${r.status}\n`; });
    var link = document.createElement("a"); link.setAttribute("href", encodeURI(csv)); link.setAttribute("download", `AEGIS_Log_${new Date().getTime()}.csv`); document.body.appendChild(link); link.click(); document.body.removeChild(link);
    addLog('SYS', 'Mengekspor database telemetri...');
}

function generatePDF() {
    addLog('SYS', 'Menyusun Laporan PDF Resmi. Harap tunggu...');
    let wasDark = !document.body.classList.contains('light-mode'); if(wasDark) toggleTheme();
    const opt = { margin: 10, filename: `Laporan_Banjir_${new Date().getTime()}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#f1f5f9' }, jsPDF: { unit: 'mm', format: 'a3', orientation: 'landscape' } };
    html2pdf().set(opt).from(document.getElementById('dashboard-core')).save().then(() => { addLog('SYS', 'Laporan PDF Berhasil Diunduh!'); if(wasDark) setTimeout(() => toggleTheme(), 500); });
}