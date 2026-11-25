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
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SensorData(BaseModel):
    device_id: str
    water_level: float              # Persentase (0-100%)
    water_height_cm: float = 0.0    # Tinggi air fisik (0-30 cm)
    distance_cm: float = 30.0       # Jarak pantul ultrasonik (0-30 cm)
    temperature: float = 0.0
    flow_rate_lpm: float = 0.0
    mass_flow_kgs: float = 0.0
    solar_v: float = 0.0
    batt_v: float = 0.0
    batt_pct: int = 0
    charge_mode: str = "SOLAR"
    system_mode: str = "AUTO"
    status: str

db_data = []
state_lock = threading.Lock()

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
        print("⚠️ Telegram gagal/timeout:", e)

@app.post("/api/upload_data")
def upload_data(data: SensorData):
    global status_terakhir, status_pompa

    pesan_telegram = ""
    with state_lock:
        pesan_pompa = ""
        if data.system_mode.upper() == "AUTO":
            if data.status == "BAHAYA" and status_pompa == "MATI":
                status_pompa = "MENYALA"
                pesan_pompa = "\n\n🚰 TINDAKAN MITIGASI:\nPOMPA PENGURAS (CH1) DIAKTIFKAN secara otomatis!"
                print("🚨 POMPA DIAKTIFKAN!")
            elif data.status != "BAHAYA" and status_pompa == "MENYALA":
                status_pompa = "MATI"
                pesan_pompa = "\n\n✅ TINDAKAN MITIGASI:\nAir turun dari batas bahaya. POMPA (CH1) DIMATIKAN."
                print("✅ POMPA DIMATIKAN!")

        tinggi_cm = data.water_height_cm if data.water_height_cm > 0 else max(0.0, round(30.0 - data.distance_cm, 1))

        record = {
            "timestamp": datetime.now().strftime("%H:%M:%S"),
            "device_id": data.device_id,
            "water_level": data.water_level,
            "water_level_pct": data.water_level,
            "water_height_cm": tinggi_cm,
            "distance_cm": data.distance_cm,
            "temperature": data.temperature,
            "flow_rate_lpm": data.flow_rate_lpm,
            "mass_flow_kgs": data.mass_flow_kgs,
            "solar_v": data.solar_v,
            "batt_v": data.batt_v,
            "batt_pct": data.batt_pct,
            "charge_mode": data.charge_mode,
            "system_mode": data.system_mode,
            "status": data.status,
            "pump_active": "ON" if status_pompa == "MENYALA" else "OFF"
        }

        db_data.append(record)
        if len(db_data) > 500:
            db_data.pop(0)

        if data.status != status_terakhir or pesan_pompa != "":
            info_air = f"Tinggi Air: {tinggi_cm:.1f} cm ({data.water_level:.1f}%)\nJarak Pantul: {data.distance_cm:.1f} cm"
            if data.status == "WASPADA":
                pesan_telegram = f"⚠️ SIAGA BANJIR KALIDERES!\n\n{info_air}\nKeterangan: Air mulai naik.{pesan_pompa}"
            elif data.status == "BAHAYA":
                pesan_telegram = f"🚨 AWAS! BAHAYA BANJIR!\n\n{info_air}\nKeterangan: Segera Evakuasi ke Posko Kelurahan Kamal!{pesan_pompa}"
            elif data.status == "AMAN":
                pesan_telegram = f"✅ KONDISI AMAN\n\n{info_air}\nKeterangan: Situasi terkendali.{pesan_pompa}"
            status_terakhir = data.status

    print(f"✅ Data masuk: {record}")

    if pesan_telegram:
        threading.Thread(target=kirim_notifikasi_telegram, args=(pesan_telegram,), daemon=True).start()

    return {"message": "Data disimpan", "data": record}

@app.get("/api/pump_status")
def get_pump_status():
    with state_lock:
        return {"pump_active": "ON" if status_pompa == "MENYALA" else "OFF"}

@app.get("/api/get_data")
def get_data():
    with state_lock:
        return {"history": list(db_data)}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
