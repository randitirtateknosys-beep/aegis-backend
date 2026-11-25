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

// ================= KONFIGURASI BOT TELEGRAM A.E.G.I.S =================
const TELEGRAM_BOT_TOKEN = "8747686027:AAHv-CpXhgpM7EvPYFdjh_vSkF6CKLVt_6Q";
const TELEGRAM_CHAT_ID   = "8233815181";

// ================= KONSTANTA KALIBRASI FISIK (SINKRON ESP32) =================
const TINGGI_DASAR_CM   = 30.0;
const BATAS_BAHAYA_CM   = 14.0; // Jarak pantul <= 14 cm (tinggi air >= 16 cm)
const BATAS_WASPADA_CM  = 22.0; // Jarak pantul <= 22 cm (tinggi air >= 8 cm)
const ATS_CUTOVER_V     = 7.0;
const ATS_RECOVER_V     = 8.0;
const SERVO_STEP        = 15;

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}
function setHTML(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

function bersihkanIP(raw) {
    if (!raw) return "";
    return String(raw)
        .replace(/^https?:\/\//i, '')
        .replace(/:81\/stream.*$/i, '')
        .replace(/\/.*$/, '')
        .trim();
}

// Helper kompatibel data firmware terbaru (water_height_cm & water_level_pct) dan log lama
function getWaterHeightCm(item) {
    if (!item) return 0;
    if (item.water_height_cm !== undefined && item.water_height_cm !== null) {
        return Number(item.water_height_cm);
    }
    if (item.distance_cm !== undefined && Number(item.distance_cm) <= TINGGI_DASAR_CM + 0.5) {
        return Math.max(0, Number((TINGGI_DASAR_CM - Number(item.distance_cm)).toFixed(1)));
    }
    return Number(item.water_level ?? 0);
}

function getWaterPct(item, heightCm) {
    if (!item) return 0;
    if (item.water_level_pct !== undefined && item.water_level_pct !== null) {
        return Math.min(100, Math.max(0, Number(item.water_level_pct)));
    }
    return Math.min(100, Math.max(0, Math.round((heightCm / TINGGI_DASAR_CM) * 100)));
}

function hitungWaterPctSimulasi(tinggiCm) {
    const jarak = Math.max(0, Math.min(TINGGI_DASAR_CM, TINGGI_DASAR_CM - tinggiCm));
    if (jarak <= BATAS_BAHAYA_CM) {
        return Number((100 - ((jarak / BATAS_BAHAYA_CM) * 20)).toFixed(1));
    } else if (jarak <= BATAS_WASPADA_CM) {
        return Number((75 - (((jarak - BATAS_BAHAYA_CM) / (BATAS_WASPADA_CM - BATAS_BAHAYA_CM)) * 25)).toFixed(1));
    } else {
        return Number((25 - (((jarak - BATAS_WASPADA_CM) / (TINGGI_DASAR_CM - BATAS_WASPADA_CM)) * 25)).toFixed(1));
    }
}

// ================= VARIABEL GLOBAL SISTEM =================
let userRole = 'developer';
let userName = 'Operator';
let loginSubmitted  = false;
let lastLocalCtrlMs = 0;

let ESPCAM_IP       = bersihkanIP(localStorage.getItem('aegis_cam_ip') || "");
let camAutoIP       = "";
let ESPMAIN_IP      = bersihkanIP(localStorage.getItem('aegis_main_ip') || "");
let isLocalCamMode  = false;
let localCamSession = 0;
let localCamTimer   = null;
let localCamWatchdg = null;
let localCamLastMs  = 0;
let lastCloudFrame  = "";

let currentCamZoom = 1.0;
let isCamCoverMode = false;
let cloudPanAngle  = 90;
let cloudTiltAngle = 90;
let isAutoSweep    = false;

// State kontrol (/kontrol) & state fisik aktual (/aegis_node)
let relayCH1_Pump    = false;
let relayCH2_Alarm   = false;
let relayCH3_Lamp    = false;
let relayCH4_Charge  = "SOLAR";
let isAutoATS        = true;
let isAutoSensorMode = true;
let localFlashStep   = 0;

let actualPumpActive  = false;
let actualAlarmActive = false;
let actualLampActive  = false;
let testAlarmLoop     = null;

let currentWaterHeightCm = 0;
let currentWaterPct      = 0;
let currentStatus        = "AMAN";
let previousStatus       = null;
let currentDeltaWater    = 0;
let currentNextPred      = 0;
let isEvacActive         = false;
let alarmPlaying         = false;
let waspadaPlaying       = false;
let systemBooted         = false;
let globalHistory        = [];
let latestLoRaRSSI       = null;
let latestLoRaSNR        = 0;
let latestLoRaPackets    = 0;
let latestNodeData       = {};
window.lastTimestamp     = null;

let iconAman, iconWaspada, iconBahaya;
var map, markerHulu, markerHilir, markerUtama, markerPosko;
var waterChart, powerVoltageChart, powerCurrentChart, routingControl, ctx;

// ================= FUNGSI KIRIM NOTIFIKASI TELEGRAM (MANUAL / PERINTAH) =================
window.sendTelegramNotification = function(pesan) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: pesan
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.ok) addLog('NET', '📲 Notifikasi Telegram terkirim ke HP.');
        else addLog('ERR', 'Gagal mengirim notifikasi Telegram.');
    })
    .catch(() => addLog('ERR', 'Koneksi ke API Telegram terputus.'));
};

// Kirim perintah lokal instan ke ESP32 Utama bila halaman dibuka via HTTP satu jaringan
function kirimKontrolLokalOpsional(pathQuery) {
    if (window.location.protocol !== 'http:' || !ESPMAIN_IP) return;
    fetch(`http://${ESPMAIN_IP}${pathQuery}`).catch(() => {});
}

// ================= AUDIO SYNTHESIZER & BEEP KONFIRMASI HALUS =================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(freq = 800, type = 'sine', duration = 0.1, vol = 0.05) {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc1.type = type;
        osc1.frequency.setValueAtTime(freq, audioCtx.currentTime);
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(freq * 1.5, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.destination);
        osc1.start();
        osc2.start();
        osc1.stop(audioCtx.currentTime + duration);
        osc2.stop(audioCtx.currentTime + duration);
    } catch (e) {}
}

function playVoiceCommandBeep() {
    playBeep(880, 'sine', 0.08, 0.04);
    setTimeout(() => { playBeep(1320, 'sine', 0.12, 0.05); }, 90);
}

function formatAngkaSuara(nilai) {
    let num = Number(nilai);
    if (isNaN(num)) return String(nilai);
    let bulat = Math.round(num * 10) / 10;
    let teks  = bulat.toString();
    if (teks.includes('.')) {
        let bagian = teks.split('.');
        if (bagian[1] === '0' || bagian[1] === '00') return bagian[0];
        return `${bagian[0]} koma ${bagian[1]}`;
    }
    return teks;
}

function bersihkanTeksSuara(teks) {
    if (!teks) return "";
    return String(teks)
        .replace(/(\d+)\.0+\b/g, '$1')
        .replace(/(\d+)\.(\d+)/g, (match, p1, p2) => {
            let desimal = p2.replace(/0+$/, '');
            if (!desimal) return p1;
            return `${p1} koma ${desimal.split('').join(' ')}`;
        })
        .replace(/\bpukul\b/gi, '')
        .replace(/\b(aegis|ejis|agis)\b/gi, 'sistem');
}

function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog');
    if (!term) return;
    let time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let clr = tipe === 'ERR' ? '#ef4444' : (tipe === 'AI' ? '#c084fc' : (tipe === 'NET' ? '#10b981' : (tipe === 'CMD' ? '#facc15' : '#38bdf8')));

    const line = document.createElement('div');
    line.className = 'terminal-line';

    const spanTime = document.createElement('span');
    spanTime.style.cssText = 'color:#64748b; width:65px; flex-shrink:0;';
    spanTime.textContent = time;

    const spanType = document.createElement('span');
    spanType.style.cssText = `color:${clr}; font-weight:bold; width:50px; flex-shrink:0;`;
    spanType.textContent = `[${tipe}]`;

    const spanMsg = document.createElement('span');
    spanMsg.style.color = 'var(--text-main)';
    spanMsg.textContent = pesan;

    line.append(spanTime, spanType, spanMsg);
    term.appendChild(line);

    while (term.children.length > 80) {
        term.removeChild(term.firstElementChild);
    }
    term.scrollTop = term.scrollHeight;
}

// ================= FUNGSI ANALISIS SEMUA SITUASI LENGKAP =================
function buatAnalisaSituasiLengkap() {
    let sV    = formatAngkaSuara(document.getElementById('top-solar-v')?.innerText || 0);
    let sI    = formatAngkaSuara(document.getElementById('top-solar-i')?.innerText || 0);
    let bV    = formatAngkaSuara(document.getElementById('top-batt-v')?.innerText || 0);
    let bPct  = (document.getElementById('top-batt-pct')?.innerText || '0%').replace('%', ' persen');
    let suhu  = formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28);
    let cuaca = document.getElementById('teks-cuaca')?.innerText || 'cerah';
    let flow  = formatAngkaSuara(document.getElementById('yf-flowrate')?.innerText || 0);
    let air   = formatAngkaSuara(currentWaterHeightCm);
    let pct   = formatAngkaSuara(currentWaterPct);
    let pred  = formatAngkaSuara(currentNextPred);

    let trenKalimat = "stabil";
    if (currentDeltaWater > 0) trenKalimat = `naik ${formatAngkaSuara(currentDeltaWater)} sentimeter dengan prediksi mencapai ${pred} sentimeter`;
    else if (currentDeltaWater < 0) trenKalimat = `surut ${formatAngkaSuara(Math.abs(currentDeltaWater))} sentimeter`;

    let mitigasiKalimat = actualPumpActive
        ? `Pompa penguras sedang aktif bekerja dengan debit aliran ${flow} liter per menit.`
        : `Pompa penguras dalam posisi siaga.`;

    let modeKalimat = isAutoSensorMode ? "mode otomatis sensor" : "mode kendali manual";
    let dayaKalimat = `Tegangan panel surya ${sV} volt dengan arus ${sI} miliampere, sedangkan tegangan baterai ${bV} volt pada kapasitas ${bPct} menggunakan mode pengisian ${relayCH4_Charge}.`;

    let kesimpulan = "";
    if (currentStatus === 'BAHAYA') {
        kesimpulan = "Peringatan darurat! Situasi saat ini berstatus BAHAYA kritis, protokol pompa dan evakuasi sedang dijalankan.";
    } else if (currentStatus === 'WASPADA') {
        kesimpulan = "Perhatian, situasi saat ini berstatus SIAGA WASPADA, lampu peringatan oranye aktif.";
    } else {
        kesimpulan = "Situasi lingkungan saat ini AMAN dan terkendali.";
    }

    return `${kesimpulan} Sistem berjalan pada ${modeKalimat}. Tinggi air ${air} sentimeter atau ${pct} persen dan tren air ${trenKalimat}. Cuaca ${cuaca} dengan suhu ${suhu} derajat celcius. ${mitigasiKalimat} ${dayaKalimat}`;
}

// ================= 1. SISTEM VOICE AI ANTI-LOOPING =================
let handsFreeStandby = true;
let manualListenMode = false;
let isSpeakingAI     = false;
let isRecRunning     = false;
let ignoreVoiceUntil = 0;
let lastProcessedTxt = "";
let lastProcessedAt  = 0;
let manualTimeout    = null;
let resumeTimer      = null;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

function updateAIButtonUI() {
    const btn = document.getElementById('btn-ai');
    const txt = document.getElementById('ai-text');
    if (!btn || !txt) return;

    if (isSpeakingAI) {
        btn.classList.add('listening');
        txt.innerText = "🔊 AI BERBICARA (KLIK UNTUK STOP)";
    } else if (manualListenMode) {
        btn.classList.add('listening');
        txt.innerText = "🎙️ SILAKAN UCAPKAN PERINTAH...";
    } else if (handsFreeStandby) {
        btn.classList.remove('listening');
        txt.innerText = 'AI SIAGA (PANGGIL "AEGIS")';
    } else {
        btn.classList.remove('listening');
        txt.innerText = "🔇 VOICE AI OFF";
    }
}

function startRecognitionSafely() {
    if (!recognition || isSpeakingAI || window.speechSynthesis.speaking || isRecRunning) return;
    if (!handsFreeStandby && !manualListenMode) return;
    try { recognition.start(); } catch (e) {}
}

function stopRecognitionSafely() {
    if (!recognition) return;
    try { recognition.abort(); } catch (e) {}
    isRecRunning = false;
}

function bicaraAI(teks, pitch = 1.05, rate = 0.98) {
    try {
        if (resumeTimer) clearTimeout(resumeTimer);
        if (manualTimeout) clearTimeout(manualTimeout);
        manualListenMode = false;
        isSpeakingAI = true;

        let teksBersih = bersihkanTeksSuara(teks);
        let estimasiDurasiMs = Math.max(2800, teksBersih.length * 80);
        ignoreVoiceUntil = Date.now() + estimasiDurasiMs + 1800;

        stopRecognitionSafely();
        window.speechSynthesis.cancel();

        let msg = new SpeechSynthesisUtterance(teksBersih);
        msg.lang = 'id-ID';
        msg.pitch = pitch;
        msg.rate = rate;
        updateAIButtonUI();

        const selesaiBicara = () => {
            isSpeakingAI = false;
            ignoreVoiceUntil = Date.now() + 1500;
            updateAIButtonUI();
            if (handsFreeStandby && systemBooted) {
                resumeTimer = setTimeout(() => { startRecognitionSafely(); }, 1600);
            }
        };

        msg.onend = selesaiBicara;
        msg.onerror = selesaiBicara;
        window.speechSynthesis.speak(msg);
    } catch (e) {
        isSpeakingAI = false;
        updateAIButtonUI();
    }
}

if (recognition) {
    recognition.lang = 'id-ID';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onstart = function() {
        isRecRunning = true;
        updateAIButtonUI();
    };

    recognition.onresult = function(e) {
        if (isSpeakingAI || window.speechSynthesis.speaking || Date.now() < ignoreVoiceUntil) return;

        const rawTranscript = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
        if (!rawTranscript || rawTranscript.length < 2) return;

        if (rawTranscript === lastProcessedTxt && (Date.now() - lastProcessedAt) < 4000) return;

        const panggilWakeWord = rawTranscript.includes('aegis') || rawTranscript.includes('ejis') || rawTranscript.includes('agis');
        if (!manualListenMode && !panggilWakeWord) return;

        lastProcessedTxt = rawTranscript;
        lastProcessedAt  = Date.now();

        let sisaKalimat = rawTranscript
            .replace(/\b(halo|hai|hei|ok|oke|tolong|aegis|ejis|agis|asisten)\b/gi, '')
            .trim();

        if (panggilWakeWord && sisaKalimat.length < 3) {
            playVoiceCommandBeep();
            addLog('AI', `🎙️ Panggilan "Aegis" aktif — silakan ucapkan perintah (8 detik)...`);
            manualListenMode = true;
            updateAIButtonUI();
            if (manualTimeout) clearTimeout(manualTimeout);
            manualTimeout = setTimeout(() => {
                manualListenMode = false;
                updateAIButtonUI();
            }, 8000);
            return;
        }

        const perintah = rawTranscript;
        let jawaban = "";

        if (perintah.includes('situasi') || perintah.includes('kondisi') || perintah.includes('laporan') || perintah.includes('analisa') || perintah.includes('semua')) {
            jawaban = buatAnalisaSituasiLengkap();
        }
        else if (perintah.includes('mode manual') || perintah.includes('sistem manual')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengubah mode sistem.";
            else { window.toggleSystemMode(false); jawaban = "Sistem dialihkan ke mode kendali manual."; }
        } else if (perintah.includes('mode sensor') || perintah.includes('sistem otomatis')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengubah mode sistem.";
            else { window.toggleSystemMode(true); jawaban = "Sistem dialihkan ke mode otomatis sensor."; }
        }
        else if (perintah.includes('kamera lokal') || perintah.includes('mode lokal')) {
            window.toggleCamMode(true);
            jawaban = "Mencoba beralih ke kamera mode lokal.";
        } else if (perintah.includes('kamera cloud') || perintah.includes('mode cloud')) {
            window.toggleCamMode(false);
            jawaban = "Kamera dialihkan ke mode cloud Firebase.";
        }
        else if (perintah.includes('mulai patroli') || perintah.includes('aktifkan patroli') || perintah.includes('patroli kamera') || perintah.includes('patroli otomatis') || perintah.includes('patroli nyala')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengaktifkan patroli kamera.";
            else { window.toggleAutoSweep(true); jawaban = "Siap. Patroli otomatis servo kamera diaktifkan."; }
        } else if (perintah.includes('hentikan patroli') || perintah.includes('matikan patroli') || perintah.includes('stop patroli') || perintah.includes('patroli mati')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat menghentikan patroli kamera.";
            else { window.toggleAutoSweep(false); jawaban = "Siap. Patroli otomatis kamera telah dihentikan."; }
        }
        else if (perintah.includes('nyalakan pompa') || perintah.includes('hidupkan pompa') || perintah.includes('aktifkan pompa') || perintah.includes('pompa nyala') || perintah.includes('pompa on')) {
            if (userRole !== 'developer') jawaban = "Maaf, akses ditolak. Hanya Developer yang dapat menyalakan pompa penguras.";
            else {
                window.setRelayChannel(1, true);
                jawaban = "Siap. Menyalakan pompa penguras air pada jalur satu sekarang.";
            }
        } else if (perintah.includes('matikan pompa') || perintah.includes('hentikan pompa') || perintah.includes('pompa mati') || perintah.includes('pompa off')) {
            if (userRole !== 'developer') jawaban = "Maaf, akses ditolak. Hanya Developer yang dapat mematikan pompa penguras.";
            else {
                window.setRelayChannel(1, false);
                jawaban = "Siap. Perintah mematikan pompa penguras air telah dikirim.";
            }
        }
        else if (perintah.includes('adaptor') || perintah.includes('cas listrik') || perintah.includes('charger')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengubah sumber pengisian daya.";
            else {
                window.setATSMode(false);
                window.toggleChargeMode('ADAPTOR');
                jawaban = "Siap. Mengalihkan jalur pengisian daya baterai ke mode Adaptor D C.";
            }
        } else if (perintah.includes('mode solar') || perintah.includes('panel surya') || perintah.includes('pakai solar') || perintah.includes('ganti ke solar') || perintah.includes('tenaga surya')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengubah sumber pengisian daya.";
            else {
                window.toggleChargeMode('SOLAR');
                jawaban = "Siap. Mengalihkan jalur pengisian daya baterai ke mode Solar Panel.";
            }
        } else if (perintah.includes('mode otomatis') || perintah.includes('ats otomatis')) {
            if (userRole !== 'developer') jawaban = "Maaf, hanya Developer yang dapat mengatur sistem A T S.";
            else { window.setATSMode(true); jawaban = "Mode Smart A T S otomatis diaktifkan."; }
        }
        else if (perintah.includes('menu daya') || perintah.includes('grafik daya') || perintah.includes('halaman daya')) {
            window.switchSubMenu('power'); jawaban = "Membuka tampilan telemetri daya dan Smart A T S.";
        } else if (perintah.includes('menu database') || perintah.includes('menu riwayat') || perintah.includes('tabel penuh')) {
            window.switchSubMenu('logs'); jawaban = "Membuka tampilan database riwayat lengkap.";
        } else if (perintah.includes('menu utama') || perintah.includes('dashboard utama') || perintah.includes('overview')) {
            window.switchSubMenu('overview'); jawaban = "Kembali ke tampilan dashboard utama.";
        }
        else if (perintah.includes('kamera kiri') || perintah.includes('geser kiri')) {
            window.moveCam('left'); jawaban = "Menggerakkan kamera ke kiri.";
        } else if (perintah.includes('kamera kanan') || perintah.includes('geser kanan')) {
            window.moveCam('right'); jawaban = "Menggerakkan kamera ke kanan.";
        } else if (perintah.includes('kamera atas') || perintah.includes('arah atas')) {
            window.moveCam('up'); jawaban = "Menggerakkan kamera ke atas.";
        } else if (perintah.includes('kamera bawah') || perintah.includes('arah bawah')) {
            window.moveCam('down'); jawaban = "Menggerakkan kamera ke bawah.";
        } else if (perintah.includes('kamera tengah') || perintah.includes('reset kamera')) {
            window.moveCam('center'); jawaban = "Mengembalikan posisi kamera ke tengah.";
        }
        else if (perintah.includes('telegram') || perintah.includes('kirim pesan')) {
            let sV = document.getElementById('top-solar-v')?.innerText || '0.00';
            let bV = document.getElementById('top-batt-v')?.innerText || '0.00';
            window.sendTelegramNotification(
                `📡 [LAPORAN VOICE AI A.E.G.I.S]\n` +
                `Mode Sistem: ${isAutoSensorMode ? 'AUTO SENSOR' : 'MANUAL'}\n` +
                `Status: ${currentStatus}\n` +
                `Tinggi Air: ${currentWaterHeightCm.toFixed(1)} cm (${currentWaterPct.toFixed(1)}%)\n` +
                `Pompa (CH1): ${actualPumpActive ? 'MENYALA' : 'STANDBY'}\n` +
                `Solar: ${sV} V | Baterai: ${bV} V\n` +
                `Mode Charge (CH4): ${relayCH4_Charge}`
            );
            jawaban = "Siap. Laporan situasi lengkap telah dikirimkan ke Telegram Anda.";
        }
        else if (perintah.includes('nyalakan lampu waspada') || perintah.includes('hidupkan lampu waspada')) {
            if (userRole === 'developer') { window.setRelayChannel(3, true); jawaban = "Lampu oranye tanda waspada telah dinyalakan."; }
            else jawaban = "Akses kontrol lampu hanya untuk Developer.";
        } else if (perintah.includes('matikan lampu waspada')) {
            if (userRole === 'developer') { window.setRelayChannel(3, false); jawaban = "Lampu oranye tanda waspada telah dimatikan."; }
            else jawaban = "Akses kontrol lampu hanya untuk Developer.";
        } else if (perintah.includes('matikan alarm') || perintah.includes('hentikan alarm')) {
            if (userRole === 'developer') { window.setRelayChannel(2, false); jawaban = "Alarm peringatan telah dimatikan."; }
            else jawaban = "Akses kontrol alarm hanya untuk Developer.";
        } else if (perintah.includes('flash') || perintah.includes('lampu kamera')) {
            if (userRole === 'developer') {
                if (perintah.includes('mati')) window.toggleFlashLED('flash_off');
                else if (perintah.includes('nyala') || perintah.includes('hidup')) window.toggleFlashLED('flash_on');
                else window.toggleFlashLED('flash');
                jawaban = "Mengubah status lampu flash kamera pemantau.";
            } else jawaban = "Akses lampu flash kamera hanya untuk Developer.";
        }
        else if (perintah.includes('air') || perintah.includes('banjir') || perintah.includes('siaga')) {
            jawaban = `Tinggi genangan air saat ini ${formatAngkaSuara(currentWaterHeightCm)} sentimeter atau ${formatAngkaSuara(currentWaterPct)} persen dengan status lingkungan ${currentStatus}. Prediksi selanjutnya ${formatAngkaSuara(currentNextPred)} sentimeter.`;
        } else if (perintah.includes('cuaca')) {
            jawaban = `Pemindaian cuaca di Kalideres saat ini menunjukkan kondisi ${document.getElementById('teks-cuaca')?.innerText || 'cerah'} dengan suhu ${formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28)} derajat celcius.`;
        } else if (perintah.includes('pompa') || perintah.includes('flow') || perintah.includes('debit')) {
            jawaban = `Pompa penguras berstatus ${actualPumpActive ? 'menyala aktif' : 'siaga'} dengan debit aliran ${formatAngkaSuara(document.getElementById('yf-flowrate')?.innerText || 0)} liter per menit.`;
        } else if (perintah.includes('suhu')) {
            jawaban = `Suhu lingkungan saat ini berada di angka ${formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28)} derajat celcius.`;
        } else if (perintah.includes('solar')) {
            let sV = formatAngkaSuara(document.getElementById('top-solar-v')?.innerText || 0);
            let sI = formatAngkaSuara(document.getElementById('top-solar-i')?.innerText || 0);
            jawaban = `Tegangan panel surya saat ini ${sV} volt dengan arus ${sI} miliampere.`;
        } else if (perintah.includes('baterai') || perintah.includes('aki') || perintah.includes('daya') || perintah.includes('tegangan')) {
            let bV   = formatAngkaSuara(document.getElementById('top-batt-v')?.innerText || 0);
            let bI   = formatAngkaSuara(document.getElementById('top-batt-i')?.innerText || 0);
            let bPct = (document.getElementById('top-batt-pct')?.innerText || '0%').replace('%', ' persen');
            jawaban = `Tegangan baterai saat ini ${bV} volt dengan arus ${bI} miliampere dan kapasitas ${bPct}. Sumber pengisian aktif menggunakan ${relayCH4_Charge}.`;
        } else if (perintah.includes('sinyal') || perintah.includes('lora')) {
            let rssiTxt = latestLoRaRSSI !== null ? `${latestLoRaRSSI} dBm dengan rasio sinyal ${formatAngkaSuara(latestLoRaSNR)} desibel` : "belum menerima paket dari gateway LoRa";
            jawaban = `Kekuatan sinyal radio LoRa terpantau ${rssiTxt}.`;
        }

        if (jawaban !== "") {
            if (manualTimeout) clearTimeout(manualTimeout);
            manualListenMode = false;
            addLog('AI', `Suara Masuk: "${perintah}"`);
            playVoiceCommandBeep();
            addLog('AI', `Suara Keluar: "${jawaban}"`);
            setTimeout(() => { bicaraAI(jawaban); }, 180);
        }
    };

    recognition.onend = function() {
        isRecRunning = false;
        updateAIButtonUI();
        if (!isSpeakingAI && !window.speechSynthesis.speaking && handsFreeStandby && systemBooted) {
            setTimeout(() => { startRecognitionSafely(); }, 1200);
        }
    };

    recognition.onerror = function(e) {
        isRecRunning = false;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            handsFreeStandby = false;
            manualListenMode = false;
            updateAIButtonUI();
            return;
        }
        if (!isSpeakingAI && handsFreeStandby && systemBooted) {
            setTimeout(() => { startRecognitionSafely(); }, 2000);
        }
    };
}

window.toggleVoiceAI = function() {
    if (!recognition) {
        alert("Browser Anda belum mendukung fitur suara Web Speech API. Gunakan Google Chrome atau Edge.");
        return;
    }

    if (isSpeakingAI || window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        isSpeakingAI = false;
        manualListenMode = false;
        ignoreVoiceUntil = Date.now() + 1000;
        updateAIButtonUI();
        return;
    }

    if (!manualListenMode) {
        manualListenMode = true;
        handsFreeStandby = true;
        playVoiceCommandBeep();
        updateAIButtonUI();
        startRecognitionSafely();
        if (manualTimeout) clearTimeout(manualTimeout);
        manualTimeout = setTimeout(() => {
            manualListenMode = false;
            updateAIButtonUI();
        }, 8000);
    } else {
        manualListenMode = false;
        if (manualTimeout) clearTimeout(manualTimeout);
        updateAIButtonUI();
    }
};

// ================= 2. PATROLI OTOMATIS SERVO KAMERA (DIKENDALIKAN PENUH OLEH ESP32) =================
function updateAutoSweepUI() {
    const btnHeader = document.getElementById('btn-autosweep');
    const btnMini   = document.getElementById('btn-autosweep-mini');
    const lblServo  = document.getElementById('cam-servo-label');

    if (btnHeader) {
        btnHeader.innerText        = isAutoSweep ? "🔄 PATROLI: ON" : "🔄 PATROLI: OFF";
        btnHeader.style.background = isAutoSweep ? "#10b981" : "transparent";
        btnHeader.style.color      = isAutoSweep ? "#000" : "#10b981";
    }
    if (btnMini) {
        btnMini.innerText        = isAutoSweep ? "🔄 STOP" : "🔄 PATROLI";
        btnMini.style.background = isAutoSweep ? "#10b981" : "rgba(56, 189, 248, 0.15)";
        btnMini.style.color      = isAutoSweep ? "#000" : "#10b981";
    }
    if (lblServo) {
        lblServo.innerText = isAutoSweep
            ? `PATROLI (${cloudPanAngle}° / ${cloudTiltAngle}°)`
            : `${cloudPanAngle}° / ${cloudTiltAngle}°`;
    }
}

window.toggleAutoSweep = function(forceState = null) {
    if (userRole !== 'developer' && forceState === null) return;
    lastLocalCtrlMs = Date.now();
    isAutoSweep = (forceState !== null) ? Boolean(forceState) : !isAutoSweep;
    const swVal = isAutoSweep ? "ON" : "OFF";

    database.ref('kontrol').update({ auto_sweep: swVal });
    kirimKontrolLokalOpsional(`/servo?auto_sweep=${swVal}`);
    updateAutoSweepUI();
    addLog('SRV', isAutoSweep
        ? `🔄 Perintah Patroli Servo (30°–150°) dikirim ke ESP32.`
        : `⏹️ Perintah Hentikan Patroli Servo dikirim ke ESP32.`);
};

// ================= 3. MODE KAMERA DUAL: CLOUD BASE64 vs LOKAL (/capture) =================
function getActiveCamIP() {
    return ESPCAM_IP || camAutoIP || "";
}

function stopLocalCamLoop() {
    localCamSession++;
    if (localCamTimer) { clearTimeout(localCamTimer); localCamTimer = null; }
    if (localCamWatchdg) { clearTimeout(localCamWatchdg); localCamWatchdg = null; }
    const camEl = document.getElementById('espcam-stream');
    if (camEl) {
        camEl.onload = null;
        camEl.onerror = null;
    }
}

function startLocalCamLoop() {
    const ip = getActiveCamIP();
    const camEl = document.getElementById('espcam-stream');
    if (!ip || !camEl) return;

    stopLocalCamLoop();
    const mySession = localCamSession;
    localCamLastMs = performance.now();
    setText('cam-ip-label', `LOKAL ${ip} (MENGHUBUNGKAN...)`);

    function requestNextFrame() {
        if (!isLocalCamMode || mySession !== localCamSession) return;
        if (localCamWatchdg) clearTimeout(localCamWatchdg);
        localCamWatchdg = setTimeout(requestNextFrame, 2800);
        camEl.src = `http://${ip}/capture?t=${Date.now()}`;
    }

    camEl.onload = function() {
        if (!isLocalCamMode || mySession !== localCamSession) return;
        if (localCamWatchdg) clearTimeout(localCamWatchdg);
        const now = performance.now();
        const fps = (1000 / Math.max(1, now - localCamLastMs)).toFixed(1);
        localCamLastMs = now;
        setText('cam-ip-label', `⚡ LOKAL ${ip} (${fps} FPS)`);
        localCamTimer = setTimeout(requestNextFrame, 40);
    };

    camEl.onerror = function() {
        if (!isLocalCamMode || mySession !== localCamSession) return;
        if (localCamWatchdg) clearTimeout(localCamWatchdg);
        setText('cam-ip-label', `⚠️ LOKAL ${ip} (RECONNECT...)`);
        localCamTimer = setTimeout(requestNextFrame, 500);
    };

    requestNextFrame();
}

function updateCamModeButtonUI() {
    const btn = document.getElementById('btn-cam-mode');
    if (!btn) return;
    if (isLocalCamMode) {
        btn.innerText = "⚡ LOKAL";
        btn.style.background = "#10b981";
        btn.style.color = "#000";
        btn.style.borderColor = "#10b981";
    } else {
        btn.innerText = "☁️ CLOUD";
        btn.style.background = "transparent";
        btn.style.color = "#38bdf8";
        btn.style.borderColor = "#38bdf8";
    }
}

window.toggleCamMode = function(forceLocal = null) {
    const targetLocal = (forceLocal !== null) ? Boolean(forceLocal) : !isLocalCamMode;

    if (targetLocal) {
        let ip = getActiveCamIP();
        if (!ip) {
            let inputIP = prompt("IP ESP32-CAM belum terdeteksi dari Firebase. Masukkan IP lokal ESP32-CAM (contoh: 192.168.43.100):", "");
            ip = bersihkanIP(inputIP);
            if (!ip) return;
            ESPCAM_IP = ip;
            localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        }
        isLocalCamMode = true;
        updateCamModeButtonUI();
        startLocalCamLoop();
        if (window.location.protocol === 'https:') {
            addLog('CAM', `⚡ Mode Lokal aktif (http://${ip}/capture). Jika gambar diblokir HTTPS browser, izinkan Mixed Content atau buka dashboard lokal.`);
        } else {
            addLog('CAM', `⚡ Beralih ke Mode Kamera Lokal langsung: http://${ip}/capture`);
        }
    } else {
        isLocalCamMode = false;
        stopLocalCamLoop();
        updateCamModeButtonUI();
        const camEl = document.getElementById('espcam-stream');
        if (camEl && lastCloudFrame) camEl.src = lastCloudFrame;
        setText('cam-ip-label', lastCloudFrame ? 'CLOUD CAM LIVE' : 'FIREBASE CLOUD CAM');
        addLog('CAM', '☁️ Beralih ke Mode Kamera Cloud Firebase.');
    }
};

// ================= 4. YOLOv10n AI DETECTION =================
let yoloActive = false;
let yoloInterval = null;

window.toggleYolo = function() {
    yoloActive = !yoloActive;
    const yCanvas = document.getElementById('yolo-canvas');
    if (!yCanvas) return;
    if (yoloActive) {
        yCanvas.style.display = 'block';
        addLog('AI', 'MENGAKTIFKAN YOLOv10n OBJECT DETECTION...');
        playBeep(1500, 'square', 0.2);
        yoloInterval = setInterval(() => {
            yCanvas.innerHTML = '';
            let numBoxes = Math.floor(Math.random() * 2) + 1;
            for (let i = 0; i < numBoxes; i++) {
                let w = 60 + Math.random() * 70;
                let h = 50 + Math.random() * 60;
                let x = Math.random() * Math.max(10, (yCanvas.clientWidth - w));
                let y = Math.random() * Math.max(10, (yCanvas.clientHeight - h));
                let conf = (85 + Math.random() * 14).toFixed(1);
                let classes = ['WATER_SURFACE', 'DEBRIS_DETECTED', 'DRAIN_FLOW'];
                let cls = classes[Math.floor(Math.random() * classes.length)];
                yCanvas.innerHTML += `<div class="yolo-bbox" style="width:${w}px; height:${h}px; left:${x}px; top:${y}px;"><div class="yolo-label">${cls} ${conf}%</div></div>`;
            }
        }, 1200);
    } else {
        yCanvas.style.display = 'none';
        if (yoloInterval) clearInterval(yoloInterval);
        yCanvas.innerHTML = '';
        addLog('AI', 'YOLOv10n DINONAKTIFKAN.');
    }
};

// ================= 5. KONTROL DASHBOARD, SIMULASI, SERVO, MODE SISTEM & RELAY =================
window.switchSubMenu = function(menuName) {
    const vOver  = document.getElementById('view-overview');
    const vPower = document.getElementById('view-power');
    const vLogs  = document.getElementById('view-logs');
    if (vOver)  vOver.style.display  = (menuName === 'overview') ? 'grid' : 'none';
    if (vPower) vPower.style.display = (menuName === 'power')    ? 'grid' : 'none';
    if (vLogs)  vLogs.style.display  = (menuName === 'logs')     ? 'block' : 'none';

    document.getElementById('tab-btn-overview')?.classList.toggle('active', menuName === 'overview');
    document.getElementById('tab-btn-power')?.classList.toggle('active', menuName === 'power');
    document.getElementById('tab-btn-logs')?.classList.toggle('active', menuName === 'logs');

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

window.toggleDeck = function() {
    if (userRole !== 'developer') return;
    document.getElementById('control-deck')?.classList.toggle('open');
    playBeep(1200, 'square', 0.1);
};

window.updateSimValue = function(val) {
    const num = Number(val);
    setText('sim-val', num.toFixed(1));
    playBeep(400 + num * 15, 'sine', 0.05, 0.01);
};

window.pushSimData = function(val) {
    if (userRole !== 'developer') return;
    let tinggiCm = Math.max(0, Math.min(TINGGI_DASAR_CM, Number(val)));
    let jarakCm  = Number((TINGGI_DASAR_CM - tinggiCm).toFixed(1));
    let stat     = jarakCm <= BATAS_BAHAYA_CM ? "BAHAYA" : (jarakCm <= BATAS_WASPADA_CM ? "WASPADA" : "AMAN");
    let pct      = hitungWaterPctSimulasi(tinggiCm);
    let timeStr  = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let lastLog  = globalHistory.length > 0 ? globalHistory[globalHistory.length - 1] : latestNodeData;

    const payload = {
        device_id: "NODE-SIM-1",
        status: stat,
        temperature: Number((28 + Math.random() * 2).toFixed(1)),
        timestamp: timeStr,
        water_level: pct,
        water_level_pct: pct,
        water_height_cm: Number(tinggiCm.toFixed(1)),
        distance_cm: jarakCm,
        flow_rate_lpm: stat === "BAHAYA" ? 12.5 : 0.0,
        mass_flow_kgs: stat === "BAHAYA" ? 0.21 : 0.0,
        solar_v: Number(lastLog.solar_v ?? 14.2),
        solar_i: Number(lastLog.solar_i ?? 310),
        solar_p: Number(lastLog.solar_p ?? 4402),
        batt_v: Number(lastLog.batt_v ?? 12.4),
        batt_i: Number(lastLog.batt_i ?? 190),
        batt_p: Number(lastLog.batt_p ?? 2356),
        batt_pct: Number(lastLog.batt_pct ?? 94),
        charge_mode: relayCH4_Charge,
        ats_mode: isAutoATS ? "AUTO" : "MANUAL",
        system_mode: isAutoSensorMode ? "AUTO" : "MANUAL",
        pump_active: (isAutoSensorMode ? (relayCH1_Pump || stat === "BAHAYA") : relayCH1_Pump) ? "ON" : "OFF",
        alarm_active: (isAutoSensorMode ? (relayCH2_Alarm || stat === "BAHAYA") : relayCH2_Alarm) ? "ON" : "OFF",
        lamp_orange: (isAutoSensorMode ? (relayCH3_Lamp || stat === "WASPADA") : relayCH3_Lamp) ? "ON" : "OFF"
    };

    database.ref('sensor/logs').push(payload);
    database.ref('aegis_node').update(payload);
    addLog('SYS', `🧪 SIMULASI: Tinggi Air ${tinggiCm.toFixed(1)} cm / Jarak ${jarakCm.toFixed(1)} cm (${pct}% - ${stat})`);
};

function updateATSButtonsUI() {
    const modeStr   = isAutoATS ? "AUTO" : "MANUAL";
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
}

    window.setATSMode = function(enableAuto) {
    if (userRole !== 'developer') return;
    lastLocalCtrlMs = Date.now();
    isAutoATS = Boolean(enableAuto);
    let modeStr = isAutoATS ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ ats_mode: modeStr });
    kirimKontrolLokalOpsional(`/relay?ats=${modeStr}`);
    updateATSButtonsUI();
    addLog('PWR', `🤖 Smart ATS diatur ke mode: ${modeStr}`);
};

function updateSystemModeUI() {
    const btnSys   = document.getElementById('btn-sys-mode');
    const badgeSys = document.getElementById('badge-sys-mode');
    const topSys   = document.getElementById('top-sys-mode');

    if (btnSys && badgeSys) {
        if (isAutoSensorMode) {
            badgeSys.innerText     = "AUTO SENSOR";
            btnSys.style.borderColor = "var(--aman)";
            btnSys.style.background  = "var(--aman)";
            btnSys.style.color       = "#000";
        } else {
            badgeSys.innerText     = "MANUAL OVERRIDE";
            btnSys.style.borderColor = "var(--waspada)";
            btnSys.style.background  = "var(--waspada)";
            btnSys.style.color       = "#000";
        }
    }
    if (topSys) {
        topSys.innerText   = isAutoSensorMode ? "AUTO" : "MANUAL";
        topSys.style.color = isAutoSensorMode ? "var(--aman)" : "var(--waspada)";
    }
}

    window.toggleSystemMode = function(forceAuto = null) {
    if (userRole !== 'developer') return;
    lastLocalCtrlMs = Date.now();
    isAutoSensorMode = (forceAuto !== null) ? Boolean(forceAuto) : !isAutoSensorMode;
    const modeStr = isAutoSensorMode ? "AUTO" : "MANUAL";
    database.ref('kontrol').update({ system_mode: modeStr });
    kirimKontrolLokalOpsional(`/relay?sys=${modeStr}`);
    updateSystemModeUI();
    addLog('SYS', `⚙️ Mode Kendali Sistem diatur ke: ${isAutoSensorMode ? 'AUTO SENSOR' : 'MANUAL'}`);
};

window.simulateBatteryVoltage = function(simBattV) {
    if (userRole !== 'developer') return;
    let lastLog = globalHistory.length > 0 ? globalHistory[globalHistory.length - 1] : latestNodeData;
    let timeStr = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let sV      = Number(lastLog.solar_v ?? 14.2);
    let sI      = Number(lastLog.solar_i ?? 320);
    let bI      = simBattV < ATS_CUTOVER_V ? 450 : 210;
    let bPct    = Math.max(0, Math.min(100, Math.round(((simBattV - 6.0) / (12.8 - 6.0)) * 100)));
    let newChg  = (simBattV < ATS_CUTOVER_V) ? "ADAPTOR" : (simBattV >= ATS_RECOVER_V ? "SOLAR" : relayCH4_Charge);

    if (isAutoATS) {
        window.toggleChargeMode(newChg);
    }

    const payload = {
        device_id: "NODE-SIM-1",
        timestamp: timeStr,
        status: currentStatus,
        water_level: currentWaterPct,
        water_level_pct: currentWaterPct,
        water_height_cm: currentWaterHeightCm,
        distance_cm: Number(Math.max(0, TINGGI_DASAR_CM - currentWaterHeightCm).toFixed(1)),
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
        charge_mode: newChg
    };

    database.ref('sensor/logs').push(payload);
    database.ref('aegis_node').update(payload);
    addLog('PWR', `🧪 Simulasi Tegangan Aki: ${simBattV.toFixed(2)}V -> Mode Charge: ${newChg}`);
};

window.moveCam = function(direction) {
    if (userRole !== 'developer') return;
    lastLocalCtrlMs = Date.now();
    if (isAutoSweep && (direction === 'left' || direction === 'right' || direction === 'center')) {
        isAutoSweep = false;
    }
    if (direction === 'left')   cloudPanAngle  = Math.min(180, cloudPanAngle + SERVO_STEP);
    if (direction === 'right')  cloudPanAngle  = Math.max(0, cloudPanAngle - SERVO_STEP);
    if (direction === 'up')     cloudTiltAngle = Math.min(180, cloudTiltAngle + SERVO_STEP);
    if (direction === 'down')   cloudTiltAngle = Math.max(0, cloudTiltAngle - SERVO_STEP);
    if (direction === 'center') { cloudPanAngle = 90; cloudTiltAngle = 90; }

    database.ref('kontrol').update({
        pan: cloudPanAngle,
        tilt: cloudTiltAngle,
        auto_sweep: isAutoSweep ? "ON" : "OFF"
    });
    kirimKontrolLokalOpsional(`/servo?pan=${cloudPanAngle}&tilt=${cloudTiltAngle}`);
    updateAutoSweepUI();
    addLog('SRV', `☁️ Servo -> X(Pan): ${cloudPanAngle}° | Y(Tilt): ${cloudTiltAngle}°`);
};

function syncTestAlarmSound() {
    if (relayCH2_Alarm) {
        document.body.classList.add('danger-mode');
        if (!testAlarmLoop) {
            playBeep(2000, 'square', 0.4, 0.12);
            testAlarmLoop = setInterval(() => { playBeep(1800, 'sawtooth', 0.25, 0.08); }, 1200);
        }
    } else {
        if (currentStatus !== 'BAHAYA') document.body.classList.remove('danger-mode');
        if (testAlarmLoop) { clearInterval(testAlarmLoop); testAlarmLoop = null; }
    }
}

function updateRelayButtonsUI() {
    // Di awal updateRelayButtonsUI() — bedakan mode AUTO SENSOR vs MANUAL:
    const pumpOn  = isAutoSensorMode ? (actualPumpActive || relayCH1_Pump) : relayCH1_Pump;
    const alarmOn = isAutoSensorMode ? (actualAlarmActive || relayCH2_Alarm) : relayCH2_Alarm;
    const lampOn  = isAutoSensorMode ? (actualLampActive || relayCH3_Lamp) : relayCH3_Lamp;

    const btn1 = document.getElementById('btn-relay-ch1');
    const bdg1 = document.getElementById('badge-ch1');
    if (btn1 && bdg1) {
        bdg1.innerText = relayCH1_Pump ? "ON" : ((isAutoSensorMode && 	actualPumpActive) ? "ON (AUTO)" : "OFF");
        btn1.style.background = pumpOn ? "var(--primary)" : "transparent";
        btn1.style.color      = pumpOn ? "#000" : "var(--primary)";
    }
    setText('top-pump-stat', pumpOn ? "ON" : "OFF");

    const pBig = document.getElementById('top-pump-big');
    if (pBig) {
        pBig.innerText   = pumpOn ? "🚰 POMPA: AKTIF" : "POMPA: STANDBY";
        pBig.style.color = pumpOn ? "var(--primary)" : "var(--text-muted)";
    }

    const pStatusTxt = document.getElementById('pump-status-text');
    if (pumpOn) {
        document.getElementById('pump-icon')?.classList.add('active');
        document.getElementById('flow-bar')?.classList.add('active');
        setText('pump-status-text', relayCH1_Pump ? 'RELAY CH1: ACTIVE (MANUAL)' : 'RELAY CH1: ACTIVE (AUTO)');
        if (pStatusTxt) pStatusTxt.style.color = 'var(--primary)';
    } else {
        document.getElementById('pump-icon')?.classList.remove('active');
        if (Number(document.getElementById('yf-flowrate')?.innerText || 0) <= 0) {
            document.getElementById('flow-bar')?.classList.remove('active');
        }
        setText('pump-status-text', 'RELAY CH1: STANDBY');
        if (pStatusTxt) pStatusTxt.style.color = 'var(--text-muted)';
    }

    const btn2 = document.getElementById('btn-relay-ch2');
    const bdg2 = document.getElementById('badge-ch2');
    if (btn2 && bdg2) {
        bdg2.innerText = relayCH2_Alarm ? "ON" : ((isAutoSensorMode && 	actualAlarmActive) ? "ON (AUTO)" : "OFF");
        btn2.style.background = alarmOn ? "var(--bahaya)" : "transparent";
        btn2.style.color      = alarmOn ? "#fff" : "var(--bahaya)";
    }
    const topAlarm = document.getElementById('top-alarm-stat');
    if (topAlarm) {
        topAlarm.innerText   = alarmOn ? "ON" : "OFF";
        topAlarm.style.color = alarmOn ? "var(--bahaya)" : "var(--text-muted)";
    }

    const btn3 = document.getElementById('btn-relay-ch3');
    const bdg3 = document.getElementById('badge-ch3');
    if (btn3 && bdg3) {
        bdg3.innerText = relayCH3_Lamp ? "ON" : ((isAutoSensorMode && 	actualLampActive) ? "ON (AUTO)" : "OFF");
        btn3.style.background = lampOn ? "var(--waspada)" : "transparent";
        btn3.style.color      = lampOn ? "#000" : "var(--waspada)";
    }
    const topLamp = document.getElementById('top-lamp-stat');
    if (topLamp) {
        topLamp.innerText   = lampOn ? "ON" : "OFF";
        topLamp.style.color = lampOn ? "var(--waspada)" : "var(--text-muted)";
    }

    const btn4   = document.getElementById('btn-relay-ch4');
    const bdg4   = document.getElementById('badge-ch4');
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

window.setRelayChannel = function(channel, targetOn) {
    if (userRole !== 'developer') return;
    lastLocalCtrlMs = Date.now();
    const st = targetOn ? "ON" : "OFF";
    if (channel === 1) {
        relayCH1_Pump = targetOn;
        database.ref('kontrol').update({ pompa: st });
        kirimKontrolLokalOpsional(`/relay?ch=1&val=${st}`);
        addLog('TST', `🚰 RELAY CH1 (Pompa): ${st}`);
    } else if (channel === 2) {
        relayCH2_Alarm = targetOn;
        database.ref('kontrol').update({ alarm: st });
        kirimKontrolLokalOpsional(`/relay?ch=2&val=${st}`);
        if (relayCH2_Alarm) bicaraAI("Pengujian sistem alarm sirine diaktifkan.");
        syncTestAlarmSound();
        addLog('TST', `🚨 RELAY CH2 (Alarm): ${st}`);
    } else if (channel === 3) {
        relayCH3_Lamp = targetOn;
        database.ref('kontrol').update({ lampu: st });
        kirimKontrolLokalOpsional(`/relay?ch=3&val=${st}`);
        addLog('TST', `🟠 RELAY CH3 (Lampu Waspada): ${st}`);
    }
    updateRelayButtonsUI();
};

window.toggleRelayTest = function(channel) {
    if (userRole !== 'developer') return;
    if (channel === 1) window.setRelayChannel(1, !relayCH1_Pump);
    else if (channel === 2) window.setRelayChannel(2, !relayCH2_Alarm);
    else if (channel === 3) window.setRelayChannel(3, !relayCH3_Lamp);
};

window.toggleChargeMode = function(forceMode = null) {
    if (userRole !== 'developer' && !forceMode) return;
    lastLocalCtrlMs = Date.now();
    relayCH4_Charge = forceMode ? forceMode : ((relayCH4_Charge === "SOLAR") ? "ADAPTOR" : "SOLAR");
    database.ref('kontrol').update({ charge_mode: relayCH4_Charge });
    kirimKontrolLokalOpsional(`/relay?ch=4&val=${relayCH4_Charge}`);
    addLog('PWR', `⚡ RELAY CH4 (Sumber Charge): MODE ${relayCH4_Charge}`);
    updateRelayButtonsUI();
};

function updateFlashUI() {
    const levels  = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
    const lvlText = levels[localFlashStep] || 'OFF';
    const btnFlash = document.getElementById('btn-flash');
    if (btnFlash) {
        btnFlash.innerText = `💡 FLASH: ${lvlText}`;
        btnFlash.style.background = localFlashStep > 0 ? '#facc15' : 'transparent';
        btnFlash.style.color = localFlashStep > 0 ? '#000' : '#facc15';
    }
    setText('cam-flash-badge', lvlText);
}

window.toggleFlashLED = function(customAction = 'flash') {
    if (userRole !== 'developer') return;
    if (customAction === 'flash_on') localFlashStep = 3;
    else if (customAction === 'flash_off') localFlashStep = 0;
    else localFlashStep = (localFlashStep + 1) % 4;

    updateFlashUI();
    database.ref('kontrol').update({ cam_flash: localFlashStep });

    const ip = getActiveCamIP();
    if (isLocalCamMode && ip) {
        fetch(`http://${ip}/flash?level=${localFlashStep}`).catch(() => {});
    }
    addLog('CAM', `💡 Lampu Flash ESP32-CAM diatur ke Level ${localFlashStep}`);
};

window.adjustZoom = function(delta) {
    currentCamZoom = Math.min(3.0, Math.max(0.5, Number((currentCamZoom + delta).toFixed(1))));
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.transform = `scale(${currentCamZoom})`;
    setText('cam-zoom-label', `${currentCamZoom.toFixed(1)}x`);
};

window.resetZoom = function() {
    currentCamZoom = 1.0;
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.transform = `scale(1.0)`;
    setText('cam-zoom-label', `1.0x`);
};

window.toggleCamFit = function() {
    isCamCoverMode = !isCamCoverMode;
    const camEl = document.getElementById('espcam-stream');
    if (camEl) camEl.style.objectFit = isCamCoverMode ? 'cover' : 'contain';
    setText('btn-fit', isCamCoverMode ? '🖼️ FIT LAYAR' : '🖼️ FULL SENSOR');
};

window.changeCamIPPrompt = function() {
    if (userRole !== 'developer') return;
    let current = getActiveCamIP();
    let inputIP = prompt("Masukkan IP Lokal ESP32-CAM (contoh: 192.168.43.100) atau kosongkan untuk auto-detect dari Firebase:", current);
    if (inputIP === null) return;

    let cleanIP = bersihkanIP(inputIP);
    if (cleanIP !== "") {
        ESPCAM_IP = cleanIP;
        localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        addLog('CAM', `⚙️ IP Lokal ESP32-CAM disimpan: ${ESPCAM_IP}`);
        window.toggleCamMode(true);
    } else {
        localStorage.removeItem('aegis_cam_ip');
        ESPCAM_IP = "";
        addLog('CAM', '⚙️ IP manual dihapus, memakai auto-detect Firebase.');
        if (isLocalCamMode) startLocalCamLoop();
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

// ================= ROLE KEAMANAN & PENGGUNA ONLINE =================
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

document.getElementById('pass-input')?.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') window.verifyLogin();
});

window.verifyLogin = function() {
    if (loginSubmitted) return;
    let rawName = document.getElementById('user-name')?.value.trim() || "Operator";
    let pass    = document.getElementById('pass-input')?.value.toLowerCase().trim() || "";

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
        const err = document.getElementById('login-error');
        if (err) err.style.display = 'block';
        const pIn = document.getElementById('pass-input');
        if (pIn) pIn.value = '';
        return;
    }

    loginSubmitted = true; // <--- Posisi yang benar di sini
    playBeep(1000, 'square', 0.2, 0.1);
    const lScr = document.getElementById('login-screen');
    if (lScr) lScr.style.opacity = '0';
    setTimeout(() => {
        if (lScr) lScr.style.visibility = 'hidden';
        setupPresence(userName, userRole);
        startBootSequence();
    }, 600);
};

// ================= ANIMASI AIR, CUACA, & PETA =================
let fluidOffset = 0;
let fluidColor  = 'rgba(56, 189, 248, 0.4)';
function renderFluid() {
    const fCanvas = document.getElementById('fluid-canvas');
    if (!fCanvas) return;
    const fCtx = fCanvas.getContext('2d');
    fCanvas.width  = fCanvas.parentElement.clientWidth;
    fCanvas.height = fCanvas.parentElement.clientHeight;
    fCtx.clearRect(0, 0, fCanvas.width, fCanvas.height);

    let ratio = Math.max(0, Math.min(1, currentWaterHeightCm / TINGGI_DASAR_CM));
    let fluidHeight = fCanvas.height - (ratio * fCanvas.height);
    if (fluidHeight < 14) fluidHeight = 14;
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

function simulatePCB() {
    setInterval(() => {
        document.getElementById('led-rx')?.classList.toggle('active');
        if (Math.random() > 0.5) document.getElementById('led-tx')?.classList.toggle('active');
    }, 180);
}

function startBootSequence() {
    const bScr = document.getElementById('boot-screen');
    if (bScr) { bScr.style.visibility = 'visible'; bScr.style.opacity = '1'; }
    const bootLog = document.getElementById('boot-log');
    const messages = [
        `> OTORISASI BERHASIL: ${userName.toUpperCase()} [${userRole.toUpperCase()}]`,
        "> MENGHUBUNGKAN KE /aegis_node, /lora_gateway & /sensor/logs...",
        "> MENGAKTIFKAN DUAL CAMERA (CLOUD + LOKAL) & VOICE AI STANDBY...",
        "> SINKRONISASI HMI KINCO, DUAL INA219 (0x41 & 0x40) & SMART ATS (<7V)...",
        "> SISTEM A.E.G.I.S SMART CLOUD SIAP."
    ];
    let i = 0;
    let bootInterval = setInterval(() => {
        if (i < messages.length) {
            if (bootLog) bootLog.innerHTML += messages[i] + "<br>";
            playBeep(450 + (i * 100), 'sine', 0.05, 0.02);
            i++;
        } else {
            clearInterval(bootInterval);
            setTimeout(() => {
                playBeep(1400, 'sine', 0.25, 0.08);
                if (bScr) bScr.style.opacity = '0';
                setTimeout(() => {
                    if (bScr) bScr.style.visibility = 'hidden';
                    const dCore = document.getElementById('dashboard-core');
                    if (dCore) dCore.style.display = 'block';
                    setTimeout(() => {
                        if (dCore) dCore.style.opacity = '1';
                        systemBooted = true;
                        setText('cam-ip-label', 'FIREBASE CLOUD CAM');
                        initMapsAndCharts();
                        startFirebaseListeners();
                        renderFluid();
                        simulatePCB();
                        updateAIButtonUI();
                        bicaraAI(`Selamat datang ${userName}. Dashboard pemantauan pintar siap beroperasi.`);
                    }, 100);
                }, 500);
            }, 250);
        }
    }, 250);
}

let isLightMode     = false;
let isSatelliteMode = true;
var mapTilesSatellite = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
var mapTilesStreet    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
var currentTileLayer;

const KALIDERES_LAT = -6.1044; const KALIDERES_LNG = 106.7022;
const POSKO_LAT     = -6.1015; const POSKO_LNG     = 106.7085;
const HULU_LAT      = -6.1150; const HULU_LNG      = 106.6950;
const HILIR_LAT     = -6.0950; const HILIR_LNG     = 106.7150;

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

window.focusPosko = function(e) {
    if (e) e.preventDefault();
    window.switchSubMenu('overview');
    if (map && markerPosko) {
        setTimeout(() => {
            map.setView([POSKO_LAT, POSKO_LNG], 16);
            markerPosko.openPopup();
        }, 220);
        addLog('MAP', '🏥 Fokus peta diarahkan ke Posko Evakuasi Kel. Kamal.');
    }
};

window.toggleTheme = function() {
    isLightMode = !isLightMode;
    document.body.classList.toggle('light-mode');
    let btn = document.getElementById('btn-theme');
    if (isLightMode) {
        if (btn) btn.innerHTML = '🌙 GELAP';
        Chart.defaults.color = '#475569';
        Chart.defaults.borderColor = 'rgba(0,0,0,0.1)';
    } else {
        if (btn) btn.innerHTML = '🌞 TERANG';
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(56,189,248,0.1)';
    }
    if (waterChart) waterChart.update();
    if (powerVoltageChart) powerVoltageChart.update();
    if (powerCurrentChart) powerCurrentChart.update();
};

const canvas = document.getElementById('weather-canvas');
const ctxCanvas = canvas ? canvas.getContext('2d') : null;
if (canvas) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
let particles = [];
let isRaining = false;
window.addEventListener('resize', () => {
    if (canvas) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
});

function createRain() {
    if (!canvas) return;
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
    if (!ctxCanvas || !canvas) return;
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

// ================= NOTIFIKASI SUARA OTOMATIS SEMUA SITUASI =================
function playVoiceAlarm(status) {
    if (status === 'BAHAYA' && !alarmPlaying) {
        playBeep(2000, 'square', 0.5, 0.12);
        bicaraAI(`Peringatan kritis! Tinggi air mencapai ${formatAngkaSuara(currentWaterHeightCm)} sentimeter dan melewati batas bahaya. Menjalankan protokol pompa penguras dan rute evakuasi sekarang!`);
        alarmPlaying = true;
        waspadaPlaying = false;
        addLog('AI', '🔊 ALARM SUARA: Status BAHAYA diumumkan.');
    } else if (status === 'WASPADA' && !waspadaPlaying) {
        playBeep(1200, 'triangle', 0.35, 0.1);
        setTimeout(() => playBeep(1500, 'triangle', 0.35, 0.1), 400);
        bicaraAI(`Perhatian! Status lingkungan memasuki mode siaga waspada pada ketinggian air ${formatAngkaSuara(currentWaterHeightCm)} sentimeter. Lampu peringatan oranye telah diaktifkan.`);
        waspadaPlaying = true;
        alarmPlaying = false;
        addLog('AI', '🔊 MODE SUARA SIAGA: Status WASPADA diumumkan.');
    } else if (status === 'AMAN') {
        alarmPlaying = false;
        waspadaPlaying = false;
    }
}

setInterval(() => {
    const now = new Date();
    setText('teks-jam', now.toLocaleTimeString('id-ID', { hour12: false }));
    setText('teks-tanggal', now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase());
}, 1000);

const cmdInputEl = document.getElementById('cmd-input');
if (cmdInputEl) {
    cmdInputEl.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && userRole === 'developer') {
            let cmd = this.value.toLowerCase().trim();
            this.value = '';
            addLog('CMD', `> ${cmd}`);
            playBeep(900, 'square', 0.05);
            if (cmd === 'clear') {
                setHTML('terminalLog', '');
            } else if (cmd === 'help') {
                addLog('SYS', 'Perintah: sys auto | sys manual | ats auto | ats manual | pump on/off | alarm on/off | lamp on/off | mode solar/adaptor | patroli on/off | cam local/cloud | flash on/off | test telegram | clear');
            } else if (cmd === 'sys auto') {
                window.toggleSystemMode(true);
            } else if (cmd === 'sys manual') {
                window.toggleSystemMode(false);
            } else if (cmd === 'cam local' || cmd === 'cam lokal') {
                window.toggleCamMode(true);
            } else if (cmd === 'cam cloud') {
                window.toggleCamMode(false);
            } else if (cmd === 'patroli on' || cmd === 'sweep on') {
                window.toggleAutoSweep(true);
            } else if (cmd === 'patroli off' || cmd === 'sweep off') {
                window.toggleAutoSweep(false);
            } else if (cmd === 'pump on') {
                window.setRelayChannel(1, true);
            } else if (cmd === 'pump off') {
                window.setRelayChannel(1, false);
            } else if (cmd === 'alarm on') {
                window.setRelayChannel(2, true);
            } else if (cmd === 'alarm off') {
                window.setRelayChannel(2, false);
            } else if (cmd === 'lamp on') {
                window.setRelayChannel(3, true);
            } else if (cmd === 'lamp off') {
                window.setRelayChannel(3, false);
            } else if (cmd === 'mode solar') {
                window.toggleChargeMode('SOLAR');
            } else if (cmd === 'mode adaptor') {
                window.toggleChargeMode('ADAPTOR');
            } else if (cmd === 'ats auto') {
                window.setATSMode(true);
            } else if (cmd === 'ats manual') {
                window.setATSMode(false);
            } else if (cmd === 'test telegram') {
                window.sendTelegramNotification(`📡 [TEST TERMINAL A.E.G.I.S]\nKoneksi Bot Telegram aktif!\nStatus: ${currentStatus} | Tinggi Air: ${currentWaterHeightCm.toFixed(1)} cm (${currentWaterPct.toFixed(1)}%)`);
            } else if (cmd === 'flash on') {
                window.toggleFlashLED('flash_on');
            } else if (cmd === 'flash off') {
                window.toggleFlashLED('flash_off');
            } else {
                addLog('ERR', `Perintah '${cmd}' tidak dikenali. Ketik 'help' untuk daftar perintah.`);
            }
        }
    });
}

function initMapsAndCharts() {
    map = L.map('map', { zoomControl: true }).setView([KALIDERES_LAT, KALIDERES_LNG], 15);
    currentTileLayer = L.tileLayer(mapTilesSatellite, { maxZoom: 19, attribution: 'Esri Satellite | A.E.G.I.S Smart Mapping' }).addTo(map);
    const btnMap = document.getElementById('btn-map-mode');
    if (btnMap) btnMap.innerHTML = '🗺️ MODE JALAN';

    iconAman    = L.divIcon({ className: 'sonar-marker', iconSize: [18, 18] });
    iconWaspada = L.divIcon({ className: 'sonar-marker sonar-warning', iconSize: [18, 18] });
    iconBahaya  = L.divIcon({ className: 'sonar-marker sonar-danger', iconSize: [18, 18] });

    markerHulu  = L.marker([HULU_LAT, HULU_LNG], { icon: iconWaspada }).addTo(map).bindPopup('<b>NODE HULU</b><br>Pemantauan Aliran Masuk');
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

    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = 'rgba(56,189,248,0.1)';
    Chart.defaults.font.family = "'JetBrains Mono', monospace";

    ctx = document.getElementById('waterChart').getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, 250);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
    waterChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'TINGGI AIR (CM)', data: [], borderColor: '#38bdf8', backgroundColor: grad, borderWidth: 2, fill: true, tension: 0.25, pointRadius: 2, pointBackgroundColor: '#38bdf8' },
                { label: 'AI PREDICTION (CM)', data: [], borderColor: '#c084fc', borderDash: [5, 5], backgroundColor: 'transparent', borderWidth: 2, fill: false, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, suggestedMax: TINGGI_DASAR_CM, title: { display: true, text: 'TINGGI AIR (CM)' } },
                x: { grid: { display: false } }
            }
        }
    });

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

    fetchWeather();
    setInterval(fetchWeather, 180000);
}

async function fetchWeather() {
    if (!systemBooted) return;
    try {
        let res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${KALIDERES_LAT}&longitude=${KALIDERES_LNG}&current_weather=true`);
        let d = (await res.json()).current_weather.weathercode;
        let n = "CERAH", i = "☀️";
        if (isRaining) { isRaining = false; if (canvas) canvas.style.opacity = 0; particles = []; }
        if (d >= 1 && d <= 3) { n = "BERAWAN"; i = "⛅"; }
        else if (d >= 51) { n = d >= 80 ? "BADAI HUJAN" : "HUJAN LOKAL"; i = d >= 80 ? "⛈️" : "🌧️"; isRaining = true; createRain(); if (canvas) canvas.style.opacity = 1; drawRain(); }
        setText('teks-cuaca', n);
        setText('ikon-cuaca', i);
    } catch (e) {}
}

// ================= RENDER TELEMETRI LIVE (/aegis_node) =================
function applyLiveNodeTelemetry(data) {
    if (!data) return;
    latestNodeData = data;

    if (data.node_ip) {
        ESPMAIN_IP = bersihkanIP(data.node_ip);
        localStorage.setItem('aegis_main_ip', ESPMAIN_IP);
    }

    currentWaterHeightCm = getWaterHeightCm(data);
    currentWaterPct      = getWaterPct(data, currentWaterHeightCm);
    currentStatus        = data.status ?? "AMAN";

    const jarakCm = data.distance_cm !== undefined
        ? Number(data.distance_cm)
        : Math.max(0, TINGGI_DASAR_CM - currentWaterHeightCm);

    setText('teks-air', currentWaterHeightCm.toFixed(1));
    setText('top-jarak', jarakCm.toFixed(1));
    if (data.temperature !== undefined) {
        setText('teks-suhu', Number(data.temperature).toFixed(1));
    }

    const sliderEl = document.getElementById('sim-slider');
    if (sliderEl && !document.getElementById('control-deck')?.classList.contains('open')) {
        sliderEl.value = currentWaterHeightCm;
        setText('sim-val', currentWaterHeightCm.toFixed(1));
    }

    if (data.flow_rate_lpm !== undefined) {
        let flowLPM = Number(data.flow_rate_lpm).toFixed(2);
        let massKGS = Number(data.mass_flow_kgs ?? ((Number(flowLPM) / 60) * 0.998)).toFixed(2);
        setText('teks-flow', flowLPM);
        setText('top-mass', massKGS);
        setText('yf-flowrate', flowLPM);
        setText('coriolis-mass', massKGS);
        if (Number(flowLPM) > 0) document.getElementById('flow-bar')?.classList.add('active');
    }

    // Dual INA219
    let sV = Number(data.solar_v ?? 0).toFixed(2);
    let sI = Number(data.solar_i ?? 0).toFixed(0);
    let sP = Number(data.solar_p ?? (Number(sV) * Number(sI))).toFixed(0);
    setText('top-solar-v', sV);
    setText('top-solar-i', sI);
    setText('top-solar-p', sP);
    setText('txt-solar', `${sV} V | ${sI} mA`);
    if (document.getElementById('bar-solar')) {
        document.getElementById('bar-solar').style.width = `${Math.min(Math.round((Number(sV) / 18) * 100), 100)}%`;
    }
    setText('det-solar-v', `${sV} V`);
    setText('det-solar-i', `${sI} mA`);
    setText('det-solar-p', `${sP} mW`);

    let numBattV = Number(data.batt_v ?? 0);
    let bV       = numBattV.toFixed(2);
    let bI       = Number(data.batt_i ?? 0).toFixed(0);
    let bPct     = Number(data.batt_pct ?? 0);

    setText('top-batt-v', bV);
    setText('top-batt-i', bI);
    setText('top-batt-pct', `${bPct}%`);
    setText('txt-batt', `${bV} V | ${bI} mA (${bPct}%)`);
    if (document.getElementById('bar-batt')) {
        document.getElementById('bar-batt').style.width = `${Math.min(100, Math.max(0, bPct))}%`;
    }
    const elAtsBatt = document.getElementById('ats-curr-batt');
    if (elAtsBatt) {
        elAtsBatt.innerText   = `${bV} V`;
        elAtsBatt.style.color = (numBattV >= 2.5 && numBattV < ATS_CUTOVER_V) ? 'var(--bahaya)' : 'var(--aman)';
    }
    setText('det-batt-v', `${bV} V`);
    setText('det-batt-i', `${bI} mA`);
    setText('det-batt-pct', `${bPct}%`);

    const cardBatt = document.getElementById('card-batt');
    if (cardBatt) {
        cardBatt.style.borderColor = (numBattV >= 2.5 && numBattV < ATS_CUTOVER_V)
            ? 'var(--bahaya)'
            : 'rgba(16, 185, 129, 0.35)';
    }

    // Di dalam applyLiveNodeTelemetry(data) — ganti blok sinkronisasi mode & servo:
    if (data.pump_active !== undefined)  actualPumpActive  = (data.pump_active === "ON" || data.pump_active === "MENYALA");
    if (data.alarm_active !== undefined) actualAlarmActive = (data.alarm_active === "ON" || data.alarm_active === "MENYALA");
    if (data.lamp_orange !== undefined)  actualLampActive  = (data.lamp_orange === "ON" || data.lamp_orange === "MENYALA");

    const amanDariEchoLokal = (Date.now() - lastLocalCtrlMs) > 2000;
    if (amanDariEchoLokal) {
        if (data.charge_mode !== undefined)  relayCH4_Charge = (data.charge_mode === "ADAPTOR") ? "ADAPTOR" : "SOLAR";
        if (data.ats_mode !== undefined)     { isAutoATS = (data.ats_mode === "AUTO"); updateATSButtonsUI(); }
        if (data.system_mode !== undefined)  { isAutoSensorMode = (data.system_mode !== "MANUAL"); updateSystemModeUI(); }
        if (data.auto_sweep !== undefined)   isAutoSweep = (data.auto_sweep === "ON" || data.auto_sweep === true);
        if (data.pan !== undefined)          cloudPanAngle  = Number(data.pan);
        if (data.tilt !== undefined)         cloudTiltAngle = Number(data.tilt);
    }

    updateAutoSweepUI();
    updateRelayButtonsUI();

    if (data.lora_rssi !== undefined && Number(data.lora_rssi) !== 0) {
        updateLoRaWidgetUI(Number(data.lora_rssi), latestLoRaSNR, data.timestamp || "LIVE", latestLoRaPackets);
    } else if (data.timestamp && latestLoRaRSSI === null) {
        setText('top-last-sync', data.timestamp);
    }

    // Peta & Rute Evakuasi (visual saja — mitigasi fisik ditangani ESP32)
    if (map && routingControl && markerPosko) {
        if (currentStatus === 'BAHAYA' && !isEvacActive) {
            isEvacActive = true;
            try { routingControl.addTo(map); } catch (e) {}
            markerPosko.openPopup();
            map.setView([KALIDERES_LAT, KALIDERES_LNG], 15);
            addLog('SYS', '🚨 PROTOKOL EVAKUASI AKTIF: Rute Posko Kel. Kamal ditampilkan.');
        } else if (currentStatus === 'AMAN' && isEvacActive) {
            isEvacActive = false;
            try { map.removeControl(routingControl); } catch (e) {}
            markerPosko.closePopup();
            addLog('SYS', '✅ KONDISI AMAN: Rute evakuasi ditutup.');
        }
    }

    // Pengumuman suara saat pulih ke AMAN
    if (systemBooted && (previousStatus === 'BAHAYA' || previousStatus === 'WASPADA') && currentStatus === 'AMAN') {
        playBeep(1000, 'sine', 0.4, 0.1);
        bicaraAI(`Perhatian. Genangan air telah surut ke ${formatAngkaSuara(currentWaterHeightCm)} sentimeter. Situasi lingkungan kembali aman.`);
        addLog('SYS', '🔈 NOTIFIKASI SUARA: KONDISI KEMBALI AMAN.');
    }
    if (systemBooted) previousStatus = currentStatus;

    // Risiko & Styling Status
    let pctRound = Math.round(currentWaterPct);
    setText('txt-risiko', `${pctRound}%`);
    if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.width = `${pctRound}%`;
    setText('top-risiko', `${pctRound}%`);

    let statusHtml = '';
    let cAir  = document.getElementById('card-air');
    let cStat = document.getElementById('card-status');

    if (currentStatus === 'AMAN') {
        if (!relayCH2_Alarm) document.body.classList.remove('danger-mode');
        statusHtml = `<span class="badge bg-aman">AMAN / NORMAL</span>`;
        if (cAir)  cAir.style.borderColor  = 'var(--glass-border)';
        if (cStat) cStat.style.borderColor = 'var(--glass-border)';
        if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--aman)';
        if (markerUtama) { markerUtama.setIcon(iconAman); markerHulu.setIcon(iconWaspada); markerHilir.setIcon(iconAman); }
        fluidColor = 'rgba(16, 185, 129, 0.4)';
    } else if (currentStatus === 'WASPADA') {
        if (!relayCH2_Alarm) document.body.classList.remove('danger-mode');
        statusHtml = `<span class="badge bg-waspada">SIAGA / WASPADA</span>`;
        if (cAir)  cAir.style.borderColor  = 'var(--waspada)';
        if (cStat) cStat.style.borderColor = 'var(--waspada)';
        if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--waspada)';
        if (markerUtama) { markerUtama.setIcon(iconWaspada); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconWaspada); }
        fluidColor = 'rgba(245, 158, 11, 0.4)';
    } else if (currentStatus === 'BAHAYA') {
        document.body.classList.add('danger-mode');
        statusHtml = `<span class="badge bg-bahaya">BAHAYA / EVAKUASI</span>`;
        if (cAir)  cAir.style.borderColor  = 'var(--bahaya)';
        if (cStat) cStat.style.borderColor = 'var(--bahaya)';
        if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--bahaya)';
        if (markerUtama) { markerUtama.setIcon(iconBahaya); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconBahaya); }
        fluidColor = 'rgba(239, 68, 68, 0.4)';
    }

    setHTML('teks-status', statusHtml);
    playVoiceAlarm(currentStatus);

    if (data.timestamp && window.lastTimestamp !== data.timestamp) {
        addLog(currentStatus === 'BAHAYA' ? 'ERR' : 'DAT', `⬇️ LIVE: Air=${currentWaterHeightCm.toFixed(1)}cm (${pctRound}%) | Solar=${sV}V | Aki=${bV}V | ${currentStatus}`);
        window.lastTimestamp = data.timestamp;
    }
}

function updateLoRaWidgetUI(rssi, snr, ts, validPkts) {
    latestLoRaRSSI    = rssi;
    latestLoRaSNR     = Number(snr || 0);
    latestLoRaPackets = Number(validPkts || 0);

    setText('top-lora-rssi', rssi);
    setText('top-lora-snr', latestLoRaSNR.toFixed(1));
    setText('top-last-sync', ts || "LIVE");
    setText('txt-lora', `${rssi} dBm | SNR ${latestLoRaSNR.toFixed(1)} dB (${latestLoRaPackets} pkt)`);

    const pctSig = Math.max(5, Math.min(100, Math.round(((rssi + 125) / 85) * 100)));
    const barEl  = document.getElementById('bar-lora');
    if (barEl) barEl.style.width = `${pctSig}%`;
}

// ================= LISTENER REALTIME FIREBASE (KAMERA, KONTROL, NODE LIVE, LORA & LOGS) =================
function startFirebaseListeners() {
    // 1. Kamera Cloud + Auto-Detect IP Lokal ESP32-CAM
    database.ref('kamera').on('value', (snap) => {
        let camData = snap.val();
        if (!camData) return;

        if (camData.ip) {
            camAutoIP = bersihkanIP(camData.ip);
        }
        if (camData.frame) {
            lastCloudFrame = camData.frame;
            if (!isLocalCamMode) {
                const camEl = document.getElementById('espcam-stream');
                if (camEl) camEl.src = camData.frame;
                setText('cam-ip-label', camAutoIP ? `CLOUD LIVE (IP: ${camAutoIP})` : 'CLOUD CAM LIVE');
            }
        }
    });

    // 2. Sinkronisasi Perintah /kontrol (Dua Arah dengan HMI Kinco & ESP32)
    database.ref('kontrol').on('value', (snapshot) => {
        let ctrl = snapshot.val() || {};
        relayCH1_Pump   = (ctrl.pompa === "ON" || ctrl.pompa === "MENYALA");
        relayCH2_Alarm  = (ctrl.alarm === "ON" || ctrl.alarm === "MENYALA");
        relayCH3_Lamp   = (ctrl.lampu === "ON" || ctrl.lampu === "MENYALA");
        relayCH4_Charge = (ctrl.charge_mode === "ADAPTOR") ? "ADAPTOR" : "SOLAR";

        if (ctrl.ats_mode !== undefined) {
            isAutoATS = (ctrl.ats_mode === "AUTO");
            updateATSButtonsUI();
        }
        if (ctrl.system_mode !== undefined) {
            isAutoSensorMode = (ctrl.system_mode !== "MANUAL");
            updateSystemModeUI();
        }
        
// Di dalam database.ref('kontrol').on('value', ...) — jangan timpa pan saat patroli berjalan:
        if (ctrl.auto_sweep !== undefined) {
            isAutoSweep = (ctrl.auto_sweep === "ON" || ctrl.auto_sweep === true);
        }
        if (ctrl.pan !== undefined && !isAutoSweep) cloudPanAngle = Number(ctrl.pan);
        if (ctrl.tilt !== undefined) cloudTiltAngle = Number(ctrl.tilt);
	updateAutoSweepUI();
        if (ctrl.cam_flash !== undefined) {
            localFlashStep = Math.max(0, Math.min(3, Number(ctrl.cam_flash)));
            updateFlashUI();
        }

        syncTestAlarmSound();
        updateRelayButtonsUI();
    });

    // 3. Data Realtime Node Utama & Fallback LoRa Gateway (/aegis_node)
    database.ref('aegis_node').on('value', (snapshot) => {
        const nodeData = snapshot.val();
        if (nodeData) applyLiveNodeTelemetry(nodeData);
    });

    // 4. Telemetri Sinyal Radio LoRa Gateway (/lora_gateway)
    database.ref('lora_gateway').on('value', (snapshot) => {
        const gw = snapshot.val();
        if (gw && gw.lora_rssi !== undefined && Number(gw.lora_rssi) !== 0) {
            updateLoRaWidgetUI(Number(gw.lora_rssi), gw.lora_snr, gw.timestamp, gw.valid_packets);
        }
    });

    // 5. Riwayat Grafik, Prediksi Tren & Tabel (/sensor/logs)
    database.ref('sensor/logs').limitToLast(25).on('value', (snapshot) => {
        globalHistory = [];
        snapshot.forEach(child => {
            const v = child.val();
            if (v) globalHistory.push(v);
        });
        if (globalHistory.length === 0) return;

        let latestLog = globalHistory[globalHistory.length - 1];
        // Jika /aegis_node belum pernah mengirim data, pakai log terakhir sebagai fallback awal
        if (!latestNodeData || !latestNodeData.timestamp) {
            applyLiveNodeTelemetry(latestLog);
        }

        let currH = getWaterHeightCm(latestLog);
        let prevH = globalHistory.length >= 2 ? getWaterHeightCm(globalHistory[globalHistory.length - 2]) : currH;
        currentDeltaWater = Number((currH - prevH).toFixed(1));
        currentNextPred   = Math.max(0, Math.min(TINGGI_DASAR_CM, Number((currH + currentDeltaWater).toFixed(1))));
        setText('top-ai-pred', currentNextPred.toFixed(1));

        const trEl = document.getElementById('top-ai-trend');
        if (trEl) {
            if (currentDeltaWater > 0)      { trEl.innerText = `▲ NAIK (+${currentDeltaWater} cm)`; trEl.style.color = "var(--bahaya)"; }
            else if (currentDeltaWater < 0) { trEl.innerText = `▼ SURUT (${currentDeltaWater} cm)`; trEl.style.color = "var(--aman)"; }
            else                            { trEl.innerText = `● STABIL (0.0 cm)`; trEl.style.color = "var(--primary)"; }
        }

        if (systemBooted && currentDeltaWater >= 4.0 && currentStatus === 'AMAN') {
            bicaraAI(`Perhatian, terdeteksi kenaikan air cukup cepat sebesar ${formatAngkaSuara(currentDeltaWater)} sentimeter.`);
        }

        // Update Grafik Elevasi Air (0–30 cm)
        let timeLabels  = globalHistory.map(item => item.timestamp || "--:--");
        let actualData  = globalHistory.map(item => getWaterHeightCm(item));
        let waterLabels = [...timeLabels, "T+1", "T+2"];
        let predData    = new Array(globalHistory.length - 1).fill(null);

        if (globalHistory.length >= 2) {
            let p1 = actualData[actualData.length - 2];
            let p2 = actualData[actualData.length - 1];
            let momentum = p2 - p1;
            let f1 = Math.max(0, Math.min(TINGGI_DASAR_CM, Number((p2 + momentum).toFixed(1))));
            let f2 = Math.max(0, Math.min(TINGGI_DASAR_CM, Number((p2 + momentum * 2).toFixed(1))));
            predData.push(p2, f1, f2);
        } else {
            predData.push(currH, currH, currH);
        }

        let dotColor = currentStatus === 'BAHAYA' ? '#ef4444' : (currentStatus === 'WASPADA' ? '#f59e0b' : '#10b981');
        if (waterChart && ctx) {
            waterChart.data.labels = waterLabels;
            waterChart.data.datasets[0].data = actualData;
            waterChart.data.datasets[0].borderColor = dotColor;
            waterChart.data.datasets[0].pointBackgroundColor = dotColor;
            waterChart.data.datasets[1].data = predData;

            let newGrad = ctx.createLinearGradient(0, 0, 0, 250);
            if (currentStatus === 'BAHAYA')      { newGrad.addColorStop(0, 'rgba(239, 68, 68, 0.5)'); newGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)'); }
            else if (currentStatus === 'WASPADA') { newGrad.addColorStop(0, 'rgba(245, 158, 11, 0.5)'); newGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)'); }
            else                                  { newGrad.addColorStop(0, 'rgba(56, 189, 248, 0.3)'); newGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)'); }
            waterChart.data.datasets[0].backgroundColor = newGrad;
            waterChart.update();
        }

        // Update Grafik Daya INA219
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

        // Update Tabel Ringkas & Tabel Penuh
        let tableHTML     = '';
        let fullTableHTML = '';
        [...globalHistory].reverse().slice(0, 25).forEach(item => {
            let ws       = item.status === 'BAHAYA' ? '#ef4444' : (item.status === 'WASPADA' ? '#f59e0b' : '#10b981');
            let itemH    = getWaterHeightCm(item);
            let itemPct  = getWaterPct(item, itemH);
            let itemDist = item.distance_cm !== undefined ? Number(item.distance_cm) : Math.max(0, TINGGI_DASAR_CM - itemH);
            let itemFlow = `${Number(item.flow_rate_lpm ?? 0).toFixed(1)} L/m`;
            let itemSolar = `${Number(item.solar_v ?? 0).toFixed(2)}V (${Number(item.solar_i ?? 0).toFixed(0)}mA)`;
            let itemBatt  = `${Number(item.batt_v ?? 0).toFixed(2)}V (${Number(item.batt_pct ?? 0)}%)`;
            let itemChg   = item.charge_mode ?? relayCH4_Charge;

            tableHTML += `<tr>
                <td>${item.timestamp || '--:--'}</td>
                <td><b>${itemH.toFixed(1)} cm</b></td>
                <td>${itemPct.toFixed(0)}%</td>
                <td>${itemFlow}</td>
                <td>${Number(item.temperature ?? 0).toFixed(1)} °C</td>
                <td style="color:#facc15;">${itemSolar}</td>
                <td style="color:#10b981;">${itemBatt}</td>
                <td style="color:${ws}; font-weight:bold;">${item.status || 'AMAN'}</td>
            </tr>`;

            fullTableHTML += `<tr>
                <td>${item.timestamp || '--:--'}</td>
                <td style="color:var(--primary);">${item.device_id || 'NODE-01'}</td>
                <td><b>${itemH.toFixed(1)} cm</b></td>
                <td>${itemPct.toFixed(1)}%</td>
                <td>${itemDist.toFixed(1)} cm</td>
                <td>${itemFlow}</td>
                <td>${Number(item.temperature ?? 0).toFixed(1)} °C</td>
                <td style="color:#facc15;">${itemSolar}</td>
                <td style="color:#10b981;">${itemBatt}</td>
                <td style="color:${itemChg === 'ADAPTOR' ? '#c084fc' : '#10b981'}; font-weight:bold;">${itemChg}</td>
                <td style="color:${ws}; font-weight:bold;">${item.status || 'AMAN'}</td>
            </tr>`;
        });
        setHTML('tableBody', tableHTML);
        setHTML('fullTableBody', fullTableHTML);
    });
}

window.downloadCSV = function() {
    if (!globalHistory.length) return;
    let csv = "Waktu,Node ID,Tinggi Air (cm),Level Air (%),Jarak Pantul (cm),Flow Rate (L/min),Temperature (C),Solar (V),Solar (mA),Battery (V),Battery (mA),Battery (%),Charge Mode (CH4),System Mode,Status\n";
    globalHistory.forEach(r => {
        let h   = getWaterHeightCm(r);
        let pct = getWaterPct(r, h);
        let d   = r.distance_cm !== undefined ? Number(r.distance_cm) : Math.max(0, TINGGI_DASAR_CM - h);
        csv += `${r.timestamp ?? ''},${r.device_id ?? ''},${h.toFixed(1)},${pct.toFixed(1)},${d.toFixed(1)},${r.flow_rate_lpm ?? 0},${r.temperature ?? 0},${r.solar_v ?? 0},${r.solar_i ?? 0},${r.batt_v ?? 0},${r.batt_i ?? 0},${r.batt_pct ?? 0},${r.charge_mode ?? 'SOLAR'},${r.system_mode ?? 'AUTO'},${r.status ?? 'AMAN'}\n`;
    });
    let blob = new Blob([csv], { type: 'text/csv' });
    let a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aegis_smart_telemetry_full.csv';
    a.click();
};

window.generatePDF = function() {
    const element = document.getElementById('dashboard-core');
    if (!element) return;
    html2pdf().set({
        margin: 6,
        filename: 'AEGIS_Smart_Report.pdf',
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 1.5, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
    }).from(element).save();
};
