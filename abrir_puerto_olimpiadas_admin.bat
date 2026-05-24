@echo off
echo Abriendo puerto 8788 para Olimpiadas...
netsh advfirewall firewall add rule name="Olimpiadas Codex 8788" dir=in action=allow protocol=TCP localport=8788
echo.
echo Listo. Si aparecio "Aceptar", vuelve a escanear el QR.
pause
