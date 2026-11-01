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

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}
function setHTML(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
}

// ================= VARIABEL GLOBAL SISTEM =================
let userRole = 'developer';
let userName = 'Operator';

let ESPCAM_IP  = localStorage.getItem('aegis_cam_ip')  || "";
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
const ATS_CUTOVER_V = 7.0;
const ATS_RECOVER_V = 8.0;
let testAlarmLoop   = null;

let currentWaterLevel = 0;
let currentStatus     = "AMAN";
let previousStatus    = null;
let currentDeltaWater = 0;
let currentNextPred   = 0;
let isPumpActive      = false;
let isEvacActive      = false;
let alarmPlaying      = false;
let waspadaPlaying    = false;
let systemBooted      = false;
let globalHistory     = [];
window.lastTimestamp  = null;

let iconAman, iconWaspada, iconBahaya;
var map, waterChart, powerVoltageChart, powerCurrentChart, routingControl, ctx;

// ================= FUNGSI KIRIM NOTIFIKASI TELEGRAM =================
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

// ================= AUDIO SYNTHESIZER & SPEECH HELPER (ANTI KATA "PUKUL") =================
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

// Mengubah angka desimal (misal "12.40" atau "14.2") menjadi teks "12 koma 4"
// sehingga TTS Bahasa Indonesia TIDAK PERNAH membacanya sebagai jam ("pukul 12.40")
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

// Sanitasi menyeluruh semua angka bertitik/titik dua di dalam kalimat suara AI
function bersihkanTeksSuara(teks) {
    if (!teks) return "";
    return String(teks)
        // Hapus ".00" atau ".0" jika bernilai bulat
        .replace(/(\d+)\.0+\b/g, '$1')
        // Ubah angka desimal "12.45" menjadi "12 koma 4 5" agar tidak pernah dibaca "pukul"
        .replace(/(\d+)\.(\d+)/g, (match, p1, p2) => {
            let desimal = p2.replace(/0+$/, '');
            if (!desimal) return p1;
            return `${p1} koma ${desimal.split('').join(' ')}`;
        })
        // Hilangkan kata "pukul" jika masih ada di kalimat
        .replace(/\bpukul\b/gi, '');
}

let isSpeakingAI = false;
function bicaraAI(teks, pitch = 1.05, rate = 0.98) {
    try {
        window.speechSynthesis.cancel();
        let teksBersih = bersihkanTeksSuara(teks);
        let msg = new SpeechSynthesisUtterance(teksBersih);
        msg.lang = 'id-ID';
        msg.pitch = pitch;
        msg.rate = rate;
        isSpeakingAI = true;
        msg.onend = () => { isSpeakingAI = false; };
        msg.onerror = () => { isSpeakingAI = false; };
        window.speechSynthesis.speak(msg);
    } catch (e) {
        isSpeakingAI = false;
    }
}

function addLog(tipe, pesan) {
    let term = document.getElementById('terminalLog');
    if (!term) return;
    let time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    let clr = tipe === 'ERR' ? '#ef4444' : (tipe === 'AI' ? '#c084fc' : (tipe === 'NET' ? '#10b981' : (tipe === 'CMD' ? '#facc15' : '#38bdf8')));
    term.innerHTML += `<div class="terminal-line"><span style="color:#64748b; width:65px;">${time}</span> <span style="color:${clr}; font-weight:bold; width:50px;">[${tipe}]</span> <span style="color:var(--text-main);">${pesan}</span></div>`;
    term.scrollTop = term.scrollHeight;
}

// ================= FUNGSI ANALISIS SEMUA SITUASI LENGKAP =================
function buatAnalisaSituasiLengkap() {
    let sV    = formatAngkaSuara(document.getElementById('top-solar-v')?.innerText || 0);
    let sI    = formatAngkaSuara(document.getElementById('top-solar-i')?.innerText || 0);
    let bV    = formatAngkaSuara(document.getElementById('top-batt-v')?.innerText || 0);
    let bPct  = (document.getElementById('top-batt-pct')?.innerText || '92%').replace('%', ' persen');
    let suhu  = formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28);
    let cuaca = document.getElementById('teks-cuaca')?.innerText || 'cerah';
    let flow  = formatAngkaSuara(document.getElementById('yf-flowrate')?.innerText || 0);
    let air   = formatAngkaSuara(currentWaterLevel);
    let pred  = formatAngkaSuara(currentNextPred);

    let trenKalimat = "stabil";
    if (currentDeltaWater > 0) trenKalimat = `sedang naik sebesar ${formatAngkaSuara(currentDeltaWater)} sentimeter dengan prediksi mencapai ${pred} sentimeter`;
    else if (currentDeltaWater < 0) trenKalimat = `sedang berangsur surut sebesar ${formatAngkaSuara(Math.abs(currentDeltaWater))} sentimeter`;

    let mitigasiKalimat = relayCH1_Pump
        ? `Pompa penguras sedang aktif bekerja dengan debit aliran ${flow} liter per menit.`
        : `Pompa penguras dalam posisi siaga.`;

    let dayaKalimat = `Tegangan panel surya ${sV} volt dengan arus ${sI} miliampere, sedangkan tegangan baterai ${bV} volt pada kapasitas ${bPct} menggunakan sumber pengisian ${relayCH4_Charge}.`;

    let kesimpulan = "";
    if (currentStatus === 'BAHAYA') {
        kesimpulan = "Peringatan darurat! Situasi saat ini berstatus BAHAYA kritis, protokol pompa dan evakuasi sedang dijalankan.";
    } else if (currentStatus === 'WASPADA') {
        kesimpulan = "Perhatian, situasi saat ini berstatus SIAGA WASPADA, lampu peringatan oranye aktif dan harap pantau kenaikan air.";
    } else {
        kesimpulan = "Secara keseluruhan situasi lingkungan saat ini AMAN dan terkendali.";
    }

    return `${kesimpulan} Tinggi air terpantau ${air} sentimeter dan tren air ${trenKalimat}. Cuaca sekitar ${cuaca} dengan suhu ${suhu} derajat celcius. ${mitigasiKalimat} ${dayaKalimat}`;
}

// ================= 1. HANDS-FREE AI VOICE ASSISTANT (CUKUP PANGGIL TANPA KLIK) =================
let handsFreeActive = true; // Default: Langsung aktif mendengarkan secara otomatis setelah login
let aiListening     = false;
let wakeWordWindow  = false; // Aktif beberapa detik setelah pengguna memanggil "Halo Aegis"
let wakeTimer       = null;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

function mulaiHandsFreeAI() {
    if (!recognition || !handsFreeActive) return;
    try {
        recognition.start();
        aiListening = true;
        const btn = document.getElementById('btn-ai');
        const txt = document.getElementById('ai-text');
        if (btn) btn.classList.add('listening');
        if (txt) txt.innerText = 'AI STANDBY (PANGGIL "AEGIS")';
    } catch (e) {}
}

if (recognition) {
    recognition.lang = 'id-ID';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = function(e) {
        if (isSpeakingAI) return; // Abaikan pantulan suara speaker sendiri
        const rawTranscript = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
        if (!rawTranscript) return;

        // Daftar kata pemicu panggilan (Wake Words) & kata kunci perintah langsung
        const adaPanggilan = rawTranscript.includes('aegis') || rawTranscript.includes('ejis') || rawTranscript.includes('agis') || rawTranscript.includes('halo') || rawTranscript.includes('hai') || rawTranscript.includes('asisten') || rawTranscript.includes('komandan');
        const adaPerintahLangsung = rawTranscript.includes('nyalakan') || rawTranscript.includes('hidupkan') || rawTranscript.includes('matikan') || rawTranscript.includes('hentikan') || rawTranscript.includes('ganti ke') || rawTranscript.includes('mode ') || rawTranscript.includes('situasi') || rawTranscript.includes('laporan') || rawTranscript.includes('status') || rawTranscript.includes('tinggi air') || rawTranscript.includes('tegangan') || rawTranscript.includes('baterai') || rawTranscript.includes('solar') || rawTranscript.includes('cuaca') || rawTranscript.includes('kirim telegram') || rawTranscript.includes('buka menu');

        // Jika pengguna hanya memanggil "Halo Aegis" / "Aegis" tanpa perintah lanjutan
        let bersihTanpaWake = rawTranscript
            .replace(/\b(halo|hai|hei|ok|oke|tolong|aegis|ejis|agis|asisten|komandan)\b/gi, '')
            .trim();

        if (adaPanggilan && bersihTanpaWake.length < 3) {
            wakeWordWindow = true;
            if (wakeTimer) clearTimeout(wakeTimer);
            wakeTimer = setTimeout(() => { wakeWordWindow = false; }, 12000);
            playBeep(1400, 'sine', 0.12, 0.06);
            addLog('AI', `🎙️ Panggilan Terdeteksi: "${rawTranscript}"`);
            bicaraAI("Ya, saya mendengarkan. Silakan sebutkan perintah atau tanyakan situasi.");
            return;
        }

        // Proses jika ada panggilan wake word, sedang dalam jendela panggil, atau kalimat perintah jelas
        if (!adaPanggilan && !wakeWordWindow && !adaPerintahLangsung) {
            return;
        }

        wakeWordWindow = false;
        const perintah = rawTranscript;
        addLog('AI', `Suara Masuk: "${perintah}"`);
        let jawaban = "";

        // --- A. MEMBACA SEMUA SITUASI / LAPORAN LENGKAP ---
        if (perintah.includes('situasi') || perintah.includes('kondisi') || perintah.includes('laporan') || perintah.includes('sistem') || perintah.includes('analisa') || perintah.includes('semua') || perintah.includes('aman')) {
            jawaban = buatAnalisaSituasiLengkap();
        }
        // --- B. KENDALI POMPA AIR (CH1) ---
        else if (perintah.includes('nyalakan pompa') || perintah.includes('hidupkan pompa') || perintah.includes('aktifkan pompa') || perintah.includes('pompa nyala') || perintah.includes('pompa on')) {
            if (userRole !== 'developer') {
                jawaban = "Maaf, akses ditolak. Hanya Developer yang dapat menyalakan pompa penguras.";
            } else {
                relayCH1_Pump = false;
                window.toggleRelayTest(1);
                jawaban = "Siap. Menyalakan pompa penguras air pada jalur satu sekarang.";
                window.sendTelegramNotification(`🚰 [VOICE AI COMMAND]\nPompa Penguras (CH1) DINYALAKAN melalui perintah suara oleh ${userName}.\nTinggi Air: ${currentWaterLevel} cm`);
            }
        } else if (perintah.includes('matikan pompa') || perintah.includes('hentikan pompa') || perintah.includes('pompa mati') || perintah.includes('pompa off')) {
            if (userRole !== 'developer') {
                jawaban = "Maaf, akses ditolak. Hanya Developer yang dapat mematikan pompa penguras.";
            } else {
                relayCH1_Pump = true;
                window.toggleRelayTest(1);
                jawaban = "Siap. Pompa penguras air telah dimatikan dan kembali ke mode siaga.";
                window.sendTelegramNotification(`✅ [VOICE AI COMMAND]\nPompa Penguras (CH1) DIMATIKAN melalui perintah suara oleh ${userName}.`);
            }
        }
        // --- C. GANTI MODE CHARGING (CH4: SOLAR / ADAPTOR) ---
        else if (perintah.includes('adaptor') || perintah.includes('cas listrik') || perintah.includes('charger')) {
            if (userRole !== 'developer') {
                jawaban = "Maaf, hanya Developer yang dapat mengubah sumber pengisian daya.";
            } else {
                window.setATSMode(false);
                window.toggleChargeMode('ADAPTOR');
                jawaban = "Siap. Mengalihkan jalur pengisian daya baterai ke mode Adaptor D C.";
                window.sendTelegramNotification(`🔌 [VOICE AI COMMAND]\nSumber Pengisian (CH4) dialihkan ke ADAPTOR DC oleh ${userName}.`);
            }
        } else if (perintah.includes('mode solar') || perintah.includes('panel surya') || perintah.includes('pakai solar') || perintah.includes('ganti ke solar') || perintah.includes('tenaga surya')) {
            if (userRole !== 'developer') {
                jawaban = "Maaf, hanya Developer yang dapat mengubah sumber pengisian daya.";
            } else {
                window.toggleChargeMode('SOLAR');
                jawaban = "Siap. Mengalihkan jalur pengisian daya baterai ke mode Solar Panel.";
                window.sendTelegramNotification(`☀️ [VOICE AI COMMAND]\nSumber Pengisian (CH4) dialihkan ke SOLAR PANEL oleh ${userName}.`);
            }
        } else if (perintah.includes('mode otomatis') || perintah.includes('ats otomatis')) {
            if (userRole !== 'developer') {
                jawaban = "Maaf, hanya Developer yang dapat mengatur sistem A T S.";
            } else {
                window.setATSMode(true);
                jawaban = "Mode Smart A T S otomatis diaktifkan. Sistem akan otomatis berpindah ke adaptor jika tegangan aki turun di bawah 7 volt.";
            }
        }
        // --- D. PINDAH SUB-MENU DENGAN SUARA ---
        else if (perintah.includes('menu daya') || perintah.includes('grafik daya') || perintah.includes('halaman daya')) {
            window.switchSubMenu('power');
            jawaban = "Membuka tampilan telemetri daya dan Smart A T S.";
        } else if (perintah.includes('menu database') || perintah.includes('menu riwayat') || perintah.includes('tabel penuh')) {
            window.switchSubMenu('logs');
            jawaban = "Membuka tampilan database riwayat lengkap.";
        } else if (perintah.includes('menu utama') || perintah.includes('dashboard utama') || perintah.includes('overview')) {
            window.switchSubMenu('overview');
            jawaban = "Kembali ke tampilan dashboard utama.";
        }
        // --- E. KENDALI ARAH SERVO KAMERA DENGAN SUARA ---
        else if (perintah.includes('kamera kiri') || perintah.includes('geser kiri')) {
            window.moveCam('left');
            jawaban = "Menggerakkan kamera ke kiri.";
        } else if (perintah.includes('kamera kanan') || perintah.includes('geser kanan')) {
            window.moveCam('right');
            jawaban = "Menggerakkan kamera ke kanan.";
        } else if (perintah.includes('kamera atas') || perintah.includes('arah atas')) {
            window.moveCam('up');
            jawaban = "Menggerakkan kamera ke atas.";
        } else if (perintah.includes('kamera bawah') || perintah.includes('arah bawah')) {
            window.moveCam('down');
            jawaban = "Menggerakkan kamera ke bawah.";
        } else if (perintah.includes('kamera tengah') || perintah.includes('reset kamera')) {
            window.moveCam('center');
            jawaban = "Mengembalikan posisi kamera ke tengah.";
        }
        // --- F. KIRIM LAPORAN KE TELEGRAM ---
        else if (perintah.includes('telegram') || perintah.includes('kirim pesan')) {
            let sV = document.getElementById('top-solar-v')?.innerText || '0.00';
            let bV = document.getElementById('top-batt-v')?.innerText || '0.00';
            window.sendTelegramNotification(
                `📡 [LAPORAN VOICE AI A.E.G.I.S]\n` +
                `Status: ${currentStatus}\n` +
                `Tinggi Air: ${currentWaterLevel} cm\n` +
                `Pompa (CH1): ${relayCH1_Pump ? 'MENYALA' : 'STANDBY'}\n` +
                `Solar: ${sV} V | Baterai: ${bV} V\n` +
                `Mode Charge (CH4): ${relayCH4_Charge}`
            );
            jawaban = "Siap. Laporan situasi lengkap telah dikirimkan ke Telegram Anda.";
        }
        // --- G. KENDALI LAMPU WASPADA (CH3), ALARM (CH2), & FLASH KAMERA ---
        else if (perintah.includes('nyalakan lampu waspada') || perintah.includes('hidupkan lampu waspada')) {
            if (userRole === 'developer') {
                relayCH3_Lamp = false; window.toggleRelayTest(3);
                jawaban = "Lampu oranye tanda waspada telah dinyalakan.";
            } else { jawaban = "Akses kontrol lampu hanya untuk Developer."; }
        } else if (perintah.includes('matikan lampu waspada')) {
            if (userRole === 'developer') {
                relayCH3_Lamp = true; window.toggleRelayTest(3);
                jawaban = "Lampu oranye tanda waspada telah dimatikan.";
            } else { jawaban = "Akses kontrol lampu hanya untuk Developer."; }
        } else if (perintah.includes('matikan alarm') || perintah.includes('hentikan alarm')) {
            if (userRole === 'developer') {
                relayCH2_Alarm = true; window.toggleRelayTest(2);
                jawaban = "Alarm peringatan telah dimatikan.";
            } else { jawaban = "Akses kontrol alarm hanya untuk Developer."; }
        } else if (perintah.includes('flash') || perintah.includes('lampu kamera')) {
            if (userRole === 'developer') {
                if (perintah.includes('mati')) window.toggleFlashLED('flash_off');
                else if (perintah.includes('nyala') || perintah.includes('hidup')) window.toggleFlashLED('flash_on');
                else window.toggleFlashLED('flash');
                jawaban = "Mengubah status lampu flash kamera pemantau.";
            } else {
                jawaban = "Akses lampu flash kamera hanya untuk Developer.";
            }
        }
        // --- H. PERTANYAAN SPESIFIK SENSOR (TANPA KATA "PUKUL") ---
        else if (perintah.includes('air') || perintah.includes('banjir') || perintah.includes('siaga')) {
            jawaban = `Tinggi genangan air saat ini ${formatAngkaSuara(currentWaterLevel)} sentimeter dengan status lingkungan ${currentStatus}. Prediksi selanjutnya ${formatAngkaSuara(currentNextPred)} sentimeter.`;
        } else if (perintah.includes('cuaca')) {
            jawaban = `Pemindaian cuaca di Kalideres saat ini menunjukkan kondisi ${document.getElementById('teks-cuaca')?.innerText || 'cerah'} dengan suhu ${formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28)} derajat celcius.`;
        } else if (perintah.includes('pompa') || perintah.includes('flow') || perintah.includes('debit')) {
            jawaban = `Pompa penguras berstatus ${relayCH1_Pump ? 'menyala aktif' : 'siaga'} dengan debit aliran ${formatAngkaSuara(document.getElementById('yf-flowrate')?.innerText || 0)} liter per menit.`;
        } else if (perintah.includes('suhu')) {
            jawaban = `Suhu lingkungan saat ini berada di angka ${formatAngkaSuara(document.getElementById('teks-suhu')?.innerText || 28)} derajat celcius.`;
        } else if (perintah.includes('solar')) {
            let sV = formatAngkaSuara(document.getElementById('top-solar-v')?.innerText || 0);
            let sI = formatAngkaSuara(document.getElementById('top-solar-i')?.innerText || 0);
            jawaban = `Tegangan panel surya saat ini ${sV} volt dengan arus ${sI} miliampere.`;
        } else if (perintah.includes('baterai') || perintah.includes('aki') || perintah.includes('daya') || perintah.includes('tegangan')) {
            let bV   = formatAngkaSuara(document.getElementById('top-batt-v')?.innerText || 0);
            let bI   = formatAngkaSuara(document.getElementById('top-batt-i')?.innerText || 0);
            let bPct = (document.getElementById('top-batt-pct')?.innerText || '92%').replace('%', ' persen');
            jawaban = `Tegangan baterai saat ini ${bV} volt dengan arus ${bI} miliampere dan kapasitas ${bPct}. Sumber pengisian aktif menggunakan ${relayCH4_Charge}.`;
        } else if (perintah.includes('sinyal') || perintah.includes('lora')) {
            jawaban = `Kekuatan sinyal radio LoRa terpantau pada ${document.getElementById('txt-lora')?.innerText || 'minus 78 dBm'}.`;
        } else if (adaPanggilan) {
            jawaban = buatAnalisaSituasiLengkap();
        }

        if (jawaban !== "") {
            addLog('AI', `Suara Keluar: "${jawaban}"`);
            bicaraAI(jawaban);
        }
    };

    // Otomatis menyambung kembali mikrofon jika dihentikan oleh browser (Hands-Free Always-On)
    recognition.onend = function() {
        if (handsFreeActive && systemBooted) {
            setTimeout(() => {
                try { recognition.start(); } catch (e) {}
            }, 300);
        }
    };
    recognition.onerror = function() {
        if (handsFreeActive && systemBooted) {
            setTimeout(() => {
                try { recognition.start(); } catch (e) {}
            }, 1000);
        }
    };
}

// Tombol AI di header berfungsi untuk mengaktifkan/menonaktifkan mode Hands-Free
window.toggleVoiceAI = function() {
    if (!recognition) {
        alert("Browser Anda belum mendukung fitur suara Web Speech API. Gunakan Google Chrome atau Edge.");
        return;
    }
    let btn = document.getElementById('btn-ai');
    let txt = document.getElementById('ai-text');
    handsFreeActive = !handsFreeActive;
    if (handsFreeActive) {
        mulaiHandsFreeAI();
        if (btn) btn.classList.add('listening');
        if (txt) txt.innerText = 'AI STANDBY (PANGGIL "AEGIS")';
        bicaraAI("Mode asisten tangan bebas aktif. Cukup panggil Aegis kapan saja.");
    } else {
        try { recognition.stop(); } catch (e) {}
        aiListening = false;
        if (btn) btn.classList.remove('listening');
        if (txt) txt.innerText = "AI MIC MUTED";
    }
};

// ================= 2. YOLOv10n AI DETECTION =================
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

// ================= 3. KONTROL DASHBOARD, SIMULASI, SERVO & RELAY (100% CLOUD FIREBASE) =================
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
        window.toggleChargeMode(newChg);
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

    database.ref('kontrol').update({ pan: cloudPanAngle, tilt: cloudTiltAngle });
    addLog('SRV', `☁️ Cloud Servo -> X(Pan): ${cloudPanAngle}° | Y(Tilt): ${cloudTiltAngle}°`);
};

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
        addLog('TST', `🚰 CLOUD RELAY CH1 (Pompa): ${st}`);
    } else if (channel === 2) {
        relayCH2_Alarm = !relayCH2_Alarm;
        let st = relayCH2_Alarm ? "ON" : "OFF";
        database.ref('kontrol').update({ alarm: st });

        if (relayCH2_Alarm) {
            document.body.classList.add('danger-mode');
            playBeep(2000, 'square', 0.5, 0.15);
            bicaraAI("Pengujian sistem alarm sirine diaktifkan.");
            if (!testAlarmLoop) {
                testAlarmLoop = setInterval(() => { playBeep(1800, 'sawtooth', 0.3, 0.1); }, 1000);
            }
        } else {
            if (currentStatus !== 'BAHAYA') document.body.classList.remove('danger-mode');
            if (testAlarmLoop) { clearInterval(testAlarmLoop); testAlarmLoop = null; }
        }
        addLog('TST', `🚨 CLOUD RELAY CH2 (Alarm): ${st}`);
    } else if (channel === 3) {
        relayCH3_Lamp = !relayCH3_Lamp;
        let st = relayCH3_Lamp ? "ON" : "OFF";
        database.ref('kontrol').update({ lampu: st });
        addLog('TST', `🟠 CLOUD RELAY CH3 (Lampu Waspada): ${st}`);
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
    addLog('PWR', `⚡ CLOUD RELAY CH4 (Sumber Charge): MODE ${relayCH4_Charge}`);
    updateRelayButtonsUI();
};

let localFlashStep = 0;
window.toggleFlashLED = function(customAction = 'flash') {
    if (userRole !== 'developer') return;
    if (customAction === 'flash_on') localFlashStep = 3;
    else if (customAction === 'flash_off') localFlashStep = 0;
    else localFlashStep = (localFlashStep + 1) % 4;

    const levels = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
    const lvlText = levels[localFlashStep] || 'OFF';
    const btnFlash = document.getElementById('btn-flash');
    if (btnFlash) {
        btnFlash.innerText = `💡 FLASH: ${lvlText}`;
        btnFlash.style.background = localFlashStep > 0 ? '#facc15' : 'transparent';
        btnFlash.style.color = localFlashStep > 0 ? '#000' : '#facc15';
    }
    setText('cam-flash-badge', lvlText);
    database.ref('kontrol').update({ cam_flash: localFlashStep });
    addLog('CAM', `💡 Lampu Flash ESP32-CAM diatur via Cloud ke: ${lvlText}`);
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
    let inputIP = prompt("Opsional (Kosongkan untuk memakai Cloud Base64 Firebase, atau isi IP lokal jika satu jaringan):", "");
    if (inputIP && inputIP.trim() !== "") {
        let cleanIP = inputIP.replace('http://', '').replace(':81/stream', '').trim();
        ESPCAM_IP = `http://${cleanIP}`;
        localStorage.setItem('aegis_cam_ip', ESPCAM_IP);
        const camEl = document.getElementById('espcam-stream');
        if (camEl) camEl.src = `${ESPCAM_IP}:81/stream`;
        setText('cam-ip-label', `${cleanIP}:81`);
    } else {
        localStorage.removeItem('aegis_cam_ip');
        ESPCAM_IP = "";
        setText('cam-ip-label', 'FIREBASE CLOUD CAM');
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
let fluidColor = 'rgba(56, 189, 248, 0.4)';
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
        "> MENGHUBUNGKAN KE FIREBASE REALTIME CLOUD & TELEGRAM BOT...",
        "> MENGAKTIFKAN HANDS-FREE AI VOICE STANDBY & CLOUD CAM...",
        "> MENGKALIBRASI DUAL INA219 & SMART ATS (<7V)...",
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
                        mulaiHandsFreeAI();
                        bicaraAI(`Selamat datang ${userName}. Sistem pemantauan pintar Aegis aktif. Cukup panggil Aegis kapan saja untuk perintah suara.`);
                    }, 100);
                }, 500);
            }, 250);
        }
    }, 250);
}

let isLightMode = false;
let isSatelliteMode = true;
var mapTilesSatellite = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
var mapTilesStreet    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
var currentTileLayer;

const KALIDERES_LAT = -6.1044; const KALIDERES_LNG = 106.7022;
const POSKO_LAT = -6.1015; const POSKO_LNG = 106.7085;
const HULU_LAT = -6.1150; const HULU_LNG = 106.6950;
const HILIR_LAT = -6.0950; const HILIR_LNG = 106.7150;

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
        if (btn) btn.innerHTML = '🌙 GELAP';
        Chart.defaults.color = '#64748b';
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
        bicaraAI(`Peringatan kritis! Tinggi air mencapai ${formatAngkaSuara(currentWaterLevel)} sentimeter dan melewati batas bahaya. Menjalankan protokol pompa penguras dan rute evakuasi sekarang!`);
        alarmPlaying = true;
        waspadaPlaying = false;
        addLog('AI', '🔊 ALARM SUARA: Status BAHAYA diumumkan.');
    } else if (status === 'WASPADA' && !waspadaPlaying) {
        playBeep(1200, 'triangle', 0.35, 0.1);
        setTimeout(() => playBeep(1500, 'triangle', 0.35, 0.1), 400);
        bicaraAI(`Perhatian! Status lingkungan memasuki mode siaga waspada pada ketinggian air ${formatAngkaSuara(currentWaterLevel)} sentimeter. Lampu peringatan oranye telah diaktifkan.`);
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
            } else if (cmd === 'pump on') {
                relayCH1_Pump = false; window.toggleRelayTest(1);
            } else if (cmd === 'pump off') {
                relayCH1_Pump = true; window.toggleRelayTest(1);
            } else if (cmd === 'alarm on') {
                relayCH2_Alarm = false; window.toggleRelayTest(2);
            } else if (cmd === 'alarm off') {
                relayCH2_Alarm = true; window.toggleRelayTest(2);
            } else if (cmd === 'mode solar') {
                window.toggleChargeMode('SOLAR');
            } else if (cmd === 'mode adaptor') {
                window.toggleChargeMode('ADAPTOR');
            } else if (cmd === 'ats auto') {
                window.setATSMode(true);
            } else if (cmd === 'ats manual') {
                window.setATSMode(false);
            } else if (cmd === 'test telegram') {
                window.sendTelegramNotification(`📡 [TEST TERMINAL A.E.G.I.S]\nKoneksi Bot Telegram aktif!\nStatus: ${currentStatus} | Tinggi Air: ${currentWaterLevel} cm`);
            } else if (cmd === 'flash on') {
                window.toggleFlashLED('flash_on');
            } else if (cmd === 'flash off') {
                window.toggleFlashLED('flash_off');
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
                { label: 'ACTUAL (CM)', data: [], borderColor: '#38bdf8', backgroundColor: grad, borderWidth: 2, fill: true, tension: 0.25, pointRadius: 2, pointBackgroundColor: '#38bdf8' },
                { label: 'AI PREDICTION', data: [], borderColor: '#c084fc', borderDash: [5, 5], backgroundColor: 'transparent', borderWidth: 2, fill: false, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, suggestedMax: 150 }, x: { grid: { display: false } } } }
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

// ================= LISTENER REALTIME FIREBASE (KAMERA, KONTROL, & SENSOR) =================
function startFirebaseListeners() {
    // 1. Listener Live Stream Kamera Base64 dari Firebase (Bisa Diakses Online dari Mana Saja)
    database.ref('kamera').on('value', (snap) => {
        let camData = snap.val();
        if (camData && camData.frame) {
            const camEl = document.getElementById('espcam-stream');
            if (camEl) camEl.src = camData.frame;
            setText('cam-ip-label', 'CLOUD CAM LIVE');
        }
    });

    // 2. Listener Kontrol Relay, ATS & Lampu Flash Kamera
    database.ref('kontrol').on('value', (snapshot) => {
        let ctrl = snapshot.val() || {};
        relayCH1_Pump   = (ctrl.pompa === "ON" || ctrl.pompa === "MENYALA");
        relayCH2_Alarm  = (ctrl.alarm === "ON" || ctrl.alarm === "MENYALA");
        relayCH3_Lamp   = (ctrl.lampu === "ON" || ctrl.lampu === "MENYALA");
        relayCH4_Charge = (ctrl.charge_mode === "ADAPTOR") ? "ADAPTOR" : "SOLAR";
        if (ctrl.ats_mode !== undefined) {
            isAutoATS = (ctrl.ats_mode === "AUTO");
        }

        if (ctrl.cam_flash !== undefined) {
            localFlashStep = Number(ctrl.cam_flash);
            const levels = ['OFF', 'LOW (30%)', 'MED (60%)', 'MAX (100%)'];
            const lvlText = levels[localFlashStep] || 'OFF';
            const btnFlash = document.getElementById('btn-flash');
            if (btnFlash) {
                btnFlash.innerText = `💡 FLASH: ${lvlText}`;
                btnFlash.style.background = localFlashStep > 0 ? '#facc15' : 'transparent';
                btnFlash.style.color = localFlashStep > 0 ? '#000' : '#facc15';
            }
            setText('cam-flash-badge', lvlText);
        }

        isPumpActive = relayCH1_Pump;
        const pStatusTxt = document.getElementById('pump-status-text');
        if (isPumpActive) {
            document.getElementById('pump-icon')?.classList.add('active');
            document.getElementById('flow-bar')?.classList.add('active');
            setText('pump-status-text', 'RELAY CH1: ACTIVE (PUMP ON)');
            if (pStatusTxt) pStatusTxt.style.color = '#fff';
        } else {
            document.getElementById('pump-icon')?.classList.remove('active');
            document.getElementById('flow-bar')?.classList.remove('active');
            setText('pump-status-text', 'RELAY CH1: STANDBY');
            if (pStatusTxt) pStatusTxt.style.color = 'var(--text-muted)';
        }
        updateRelayButtonsUI();
    });

    // 3. Listener Telemetri Sensor Real-Time
    database.ref('sensor/logs').limitToLast(20).on('value', (snapshot) => {
        globalHistory = [];
        snapshot.forEach(child => { globalHistory.push(child.val()); });
        if (globalHistory.length > 0) {
            let data = globalHistory[globalHistory.length - 1];
            currentWaterLevel = Number(data.water_level ?? 0);
            currentStatus = data.status ?? "AMAN";

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
                document.getElementById('flow-bar')?.classList.add('active');
            } else if (!isPumpActive) {
                document.getElementById('flow-bar')?.classList.remove('active');
            }

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
                    window.toggleChargeMode("ADAPTOR");
                    playBeep(1600, 'sawtooth', 0.4, 0.12);
                    bicaraAI(`Peringatan daya. Tegangan baterai turun ke ${formatAngkaSuara(bV)} volt. Sistem Smart A T S otomatis mengalihkan pengisian ke Adaptor.`);
                    addLog('PWR', `⚠️ SMART ATS: Tegangan Aki turun ke ${bV}V (< 7.0V)! Otomatis pindah ke ADAPTOR (CH4 ON).`);
                    window.sendTelegramNotification(`⚡ [SMART ATS CUTOVER]\nTegangan Aki turun ke ${bV}V (< 7.0V)!\nRelay CH4 otomatis memindahkan sumber pengisian ke ADAPTOR DC.`);
                } else if (numBattV >= ATS_RECOVER_V && relayCH4_Charge === "ADAPTOR") {
                    window.toggleChargeMode("SOLAR");
                    bicaraAI(`Informasi daya. Tegangan baterai telah pulih ke ${formatAngkaSuara(bV)} volt. Pengisian dikembalikan ke mode Solar Panel.`);
                    addLog('PWR', `☀️ SMART ATS: Tegangan Aki pulih ke ${bV}V (>= 8.0V). Kembali ke SOLAR PANEL (CH4 OFF).`);
                    window.sendTelegramNotification(`☀️ [SMART ATS RECOVERY]\nTegangan Aki pulih ke ${bV}V (>= 8.0V).\nRelay CH4 kembali menggunakan SOLAR PANEL.`);
                }
            }
            if (cardBatt) {
                cardBatt.style.borderColor = (numBattV > 0.1 && numBattV < ATS_CUTOVER_V) ? 'var(--bahaya)' : 'rgba(16, 185, 129, 0.35)';
            }

            let lRssi = data.lora_rssi ?? -78;
            setText('top-lora-rssi', lRssi);
            setText('top-last-sync', data.timestamp || "LIVE");
            setText('txt-lora', `${lRssi} dBm`);
            if (document.getElementById('bar-lora')) document.getElementById('bar-lora').style.width = `${Math.max(10, Math.min(100, 130 + Number(lRssi)))}%`;

            let prevWater = globalHistory.length >= 2 ? Number(globalHistory[globalHistory.length - 2].water_level ?? 0) : currentWaterLevel;
            currentDeltaWater = Number((currentWaterLevel - prevWater).toFixed(1));
            currentNextPred   = Math.max(0, Number((currentWaterLevel + currentDeltaWater).toFixed(1)));
            setText('top-ai-pred', currentNextPred.toFixed(1));
            const trEl = document.getElementById('top-ai-trend');
            if (trEl) {
                if (currentDeltaWater > 0) { trEl.innerText = `▲ NAIK (+${currentDeltaWater} cm)`; trEl.style.color = "var(--bahaya)"; }
                else if (currentDeltaWater < 0) { trEl.innerText = `▼ SURUT (${currentDeltaWater} cm)`; trEl.style.color = "var(--aman)"; }
                else { trEl.innerText = `● STABIL (0.0 cm)`; trEl.style.color = "var(--primary)"; }
            }

            // Peringatan suara otomatis jika air melonjak cepat (>= 15 cm dalam satu siklus) meski belum mencapai status bahaya
            if (systemBooted && currentDeltaWater >= 15 && data.status === 'AMAN') {
                bicaraAI(`Perhatian, terdeteksi kenaikan air cukup cepat sebesar ${formatAngkaSuara(currentDeltaWater)} sentimeter.`);
            }

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

            if (systemBooted && previousStatus !== null && previousStatus !== data.status) {
                if (data.status === 'WASPADA') {
                    window.sendTelegramNotification(
                        `⚠️ [PERINGATAN SIAGA / WASPADA]\n` +
                        `Lokasi: Kp. Sawah Mede, Kalideres\n` +
                        `Tinggi Air: ${currentWaterLevel} cm\n` +
                        `Lampu Waspada Oranye (CH3): MENYALA\n` +
                        `Solar: ${sV}V | Baterai: ${bV}V`
                    );
                } else if (data.status === 'BAHAYA') {
                    window.sendTelegramNotification(
                        `🚨 [PERINGATAN KRITIS / BAHAYA BANJIR]\n` +
                        `Lokasi: Kp. Sawah Mede, Kalideres\n` +
                        `Tinggi Air: ${currentWaterLevel} cm (Melewati Batas Bahaya!)\n` +
                        `Tindakan: Pompa Penguras (CH1) & Alarm Sirine (CH2) DIAKTIFKAN Otomatis!`
                    );
                } else if ((previousStatus === 'BAHAYA' || previousStatus === 'WASPADA') && data.status === 'AMAN') {
                    playBeep(1000, 'sine', 0.4, 0.1);
                    bicaraAI(`Perhatian. Genangan air telah surut ke ${formatAngkaSuara(currentWaterLevel)} sentimeter. Situasi lingkungan kembali aman.`);
                    addLog('SYS', '🔈 NOTIFIKASI SUARA: KONDISI KEMBALI AMAN.');
                    window.sendTelegramNotification(
                        `✅ [KONDISI KEMBALI AMAN]\n` +
                        `Genangan air telah surut ke ${currentWaterLevel} cm.\n` +
                        `Pompa Penguras (CH1) & Alarm (CH2) kembali ke mode STANDBY.`
                    );
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
                if (cAir) cAir.style.borderColor = 'var(--glass-border)';
                if (cStat) cStat.style.borderColor = 'var(--glass-border)';
                dotColor = '#10b981';
                if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--aman)';
                markerUtama.setIcon(iconAman); markerHulu.setIcon(iconWaspada); markerHilir.setIcon(iconAman);
                fluidColor = 'rgba(16, 185, 129, 0.4)';
            } else if (data.status === 'WASPADA') {
                document.body.classList.remove('danger-mode');
                statusHtml = `<span class="badge bg-waspada">SIAGA / WASPADA</span>`;
                if (cAir) cAir.style.borderColor = 'var(--waspada)';
                if (cStat) cStat.style.borderColor = 'var(--waspada)';
                dotColor = '#f59e0b';
                if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--waspada)';
                markerUtama.setIcon(iconWaspada); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconWaspada);
                fluidColor = 'rgba(245, 158, 11, 0.4)';
            } else if (data.status === 'BAHAYA') {
                document.body.classList.add('danger-mode');
                statusHtml = `<span class="badge bg-bahaya">BAHAYA / EVAKUASI</span>`;
                if (cAir) cAir.style.borderColor = 'var(--bahaya)';
                if (cStat) cStat.style.borderColor = 'var(--bahaya)';
                dotColor = '#ef4444';
                if (document.getElementById('bar-risiko')) document.getElementById('bar-risiko').style.background = 'var(--bahaya)';
                markerUtama.setIcon(iconBahaya); markerHulu.setIcon(iconBahaya); markerHilir.setIcon(iconBahaya);
                fluidColor = 'rgba(239, 68, 68, 0.4)';
            }

            setHTML('teks-status', statusHtml);
            playVoiceAlarm(data.status);
            if (window.lastTimestamp !== data.timestamp) {
                addLog(data.status === 'BAHAYA' ? 'ERR' : 'DAT', `⬇️ CLOUD SYNC: Air=${currentWaterLevel}cm | Solar=${sV}V | Aki=${bV}V`);
                window.lastTimestamp = data.timestamp;
            }

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
