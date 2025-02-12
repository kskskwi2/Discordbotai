@echo off
echo Starting Ollama server...
start "" "ollama" serve
ping 127.0.0.1 -n 6 >nul
echo Starting Discord bot...
node index.js
pause