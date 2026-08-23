from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from datetime import datetime
from fastapi.middleware.cors import CORSMiddleware
import requests 

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
    status: str

db_data = []

# --- PENGATURAN TELEGRAM ---
TELEGRAM_TOKEN = "8747686027:AAHv-CpXhgpM7EvPYFdjh_vSkF6CKLVt_6Q"
TELEGRAM_CHAT_ID = "8233815181"

# Variabel Memori Sistem
status_terakhir = "AMAN"
status_pompa = "MATI" # <-- INI YANG TERLEWAT! Memori Histeresis Pompa

def kirim_notifikasi_telegram(pesan):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": pesan}
    try:
        requests.post(url, json=payload)
    except Exception as e:
        print("❌ Gagal mengirim pesan Telegram:", e)

@app.post("/api/upload_data")
async def upload_data(data: SensorData):
    global status_terakhir, status_pompa
    
    # 1. LOGIKA MITIGASI POMPA (HISTERESIS) DI SERVER
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
        "status": data.status,
        "pump_active": status_pompa # Mengirim status pompa kembali ke web & ESP32
    }
    db_data.append(record)
    print(f"Data masuk: {record}")
    
    # 2. LOGIKA NOTIFIKASI TELEGRAM
    if data.status != status_terakhir or pesan_pompa != "":
        if data.status == "WASPADA":
            pesan = f"⚠️ SIAGA BANJIR KALIDERES!\n\nTinggi Air: {data.water_level} cm\nKeterangan: Air mulai naik.{pesan_pompa}"
            kirim_notifikasi_telegram(pesan)
        elif data.status == "BAHAYA":
            pesan = f"🚨 AWAS! BAHAYA BANJIR!\n\nTinggi Air: {data.water_level} cm\nKeterangan: Segera Evakuasi ke Posko Kelurahan Kamal!{pesan_pompa}"
            kirim_notifikasi_telegram(pesan)
        elif data.status == "AMAN":
            pesan = f"✅ KONDISI AMAN\n\nTinggi Air: {data.water_level} cm\nKeterangan: Situasi terkendali.{pesan_pompa}"
            kirim_notifikasi_telegram(pesan)
            
        status_terakhir = data.status

    return {"message": "Data disimpan", "data": record}

# Endpoint khusus agar ESP32 bisa bertanya "Apakah saya harus menyalakan relay pompa?"
@app.get("/api/pump_status")
async def get_pump_status():
    return {"pump_active": status_pompa}

@app.get("/api/get_data")
async def get_data():
    return {"history": db_data}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)