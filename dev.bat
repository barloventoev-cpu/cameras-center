@echo off
REM Levanta el stack de Cameras Center en 3 ventanas separadas:
REM   server :4000  +  agent :4100  +  web :5173
cd /d "%~dp0"
start "CC server :4000" cmd /k "npm run dev:server"
start "CC agent :4100" cmd /k "npm run dev:agent"
start "CC web :5173" cmd /k "npm run dev:web"
echo Stack de Cameras Center iniciado (server :4000, agent :4100, web :5173).
