@echo off
chcp 65001 >nul
setlocal
title Bombarcade - корабельный терминал
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Не найден Node.js - он нужен для локального сервера Bombarcade.
  echo.
  echo      1. Открой https://nodejs.org и установи версию LTS ^(22 или новее^).
  echo      2. При установке оставь включённым пункт "Add to PATH".
  echo      3. Запусти этот файл снова.
  echo.
  echo  Интернет нужен только для установки Node.js. Сама игра работает без интернета.
  echo.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo.
  for /f "delims=" %%v in ('node -v') do echo  [!] Установлен Node.js %%v, а нужна версия 22 или новее.
  echo      Обнови Node.js с https://nodejs.org ^(версия LTS^) и запусти этот файл снова.
  echo.
  pause
  exit /b 1
)

if not exist "public\index.html" (
  echo.
  echo  [!] Не найдены файлы игры. Распакуй архив Bombarcade целиком и запусти файл из его папки.
  echo.
  pause
  exit /b 1
)

node server.mjs
echo.
echo  Сервер Bombarcade остановлен.
pause
