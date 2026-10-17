# Spelling checker tool

## Backend Setup (`sc-be`)

### 1. Activate Virtual Environment
```bash
cd sc-be
source sc-env/bin/activate
```

### 2. Install Requirements
```bash
pip install -r requirements.txt
```

### 3. Run FastAPI Server (Port 3035)
Using Python directly:
```bash
python server.py
```

Or using Uvicorn CLI:
```bash
uvicorn server:app --host 0.0.0.0 --port 3035 --reload
```

Server endpoints:
- Root & status: `http://localhost:3035/`
- Health check: `http://localhost:3035/health`
- Interactive API Docs (Swagger): `http://localhost:3035/docs`