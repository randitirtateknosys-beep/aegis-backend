from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from datetime import datetime
from fastapi.middleware.cors import CORSMiddleware
import requests
import threading

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SensorData(BaseModel):
    device_id: str
    water_level: float
    temperature: float
    flow_rate_lpm: float = 0.0
    mass_flow_kgs: float = 0.0
    status: str

db_data = []

# --- PENGATURAN TELEGRAM ---
TELEGRAM_TOKEN = "8747686027:AAHv-CpXhgpM7EvPYFdjh_vSkF6CKLVt_6Q"
TELEGRAM_CHAT_ID = "8233815181"

status_terakhir = "AMAN"
status_pompa = "MATI"

def kirim_notifikasi_telegram(pesan: str):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": pesan}
    try:
        requests.post(url, json=payload, timeout=4)
        print("📨 Notifikasi Telegram terkirim!")
    except Exception as e:
        print("⚠️ Telegram gagal/timeout (diabaikan agar server tetap jalan):", e)

# Gunakan "def" biasa (bukan "async def") agar FastAPI menjalankannya di threadpool non-blocking
@app.post("/api/upload_data")
def upload_data(data: SensorData):
    global status_terakhir, status_pompa
    
    # 1. LOGIKA MITIGASI POMPA (HISTERESIS)
    pesan_pompa = ""
    if data.status == "BAHAYA" and status_pompa == "MATI":
        status_pompa = "MENYALA"
        pesan_pompa = "\n\n🚰 TINDAKAN MITIGASI:\nSistem telah MENGAKTIFKAN POMPA PENGURAS secara otomatis!"
        print("🚨 POMPA DIAKTIFKAN!")
        
    elif data.status == "AMAN" and status_pompa == "MENYALA":
        status_pompa = "MATI"
        pesan_pompa = "\n\n✅ TINDAKAN MITIGASI:\nAir sudah surut ke level aman. POMPA DIMATIKAN."
        print("✅ POMPA DIMATIKAN!")

    record = {
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "device_id": data.device_id,
        "water_level": data.water_level,
        "temperature": data.temperature,
        "flow_rate_lpm": data.flow_rate_lpm,
        "mass_flow_kgs": data.mass_flow_kgs,
        "status": data.status,
        "pump_active": status_pompa
    }
    
    db_data.append(record)
    if len(db_data) > 500:
        db_data.pop(0)
        
    print(f"✅ Data masuk: {record}")
    
    # 2. JALANKAN TELEGRAM DI THREAD TERPISAH (FIRE-AND-FORGET)
    if data.status != status_terakhir or pesan_pompa != "":
        pesan = ""
        if data.status == "WASPADA":
            pesan = f"⚠️ SIAGA BANJIR KALIDERES!\n\nTinggi Air: {data.water_level} cm\nKeterangan: Air mulai naik.{pesan_pompa}"
        elif data.status == "BAHAYA":
            pesan = f"🚨 AWAS! BAHAYA BANJIR!\n\nTinggi Air: {data.water_level} cm\nKeterangan: Segera Evakuasi ke Posko Kelurahan Kamal!{pesan_pompa}"
        elif data.status == "AMAN":
            pesan = f"✅ KONDISI AMAN\n\nTinggi Air: {data.water_level} cm\nKeterangan: Situasi terkendali.{pesan_pompa}"
            
        if pesan:
            # Thread daemon akan berjalan sendiri di belakang layar tanpa menahan respon ke ESP32
            threading.Thread(target=kirim_notifikasi_telegram, args=(pesan,), daemon=True).start()
            
        status_terakhir = data.status

    return {"message": "Data disimpan", "data": record}

@app.get("/api/pump_status")
def get_pump_status():
    return {"pump_active": status_pompa}

@app.get("/api/get_data")
def get_data():
    return {"history": db_data}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
