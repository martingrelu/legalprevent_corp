# Propuesta D5 — medición de accesibilidad de AEPD e INSST desde GitHub Actions (NO EJECUTADA)

**Estado: preparada, sin activar.** Nada de esto se ha ejecutado ni se ha enviado a GitHub. El workflow tiene extensión
`.draft` a propósito, para que no se active aunque se fusione esta rama.

## Objetivo

Saber, con datos y no a ojo, si `www.aepd.es` e `www.insst.es` responden a peticiones desde los ejecutores de GitHub
Actions (`ubuntu-24.04`), porque ambos pueden bloquear IPs de centros de datos. El resultado decide si el check de fuentes
web (F2.3b) puede ser **bloqueante** o debe ser **informativo** para esas dos autoridades. La medición es **no bloqueante**:
no falla el job aunque las fuentes no respondan.

## Procedimiento (cuando se autorice)

1. Revisar y fusionar el diff en una rama de prueba; renombrar `sources-reachability.yml.draft` a
   `.github/workflows/sources-reachability.yml` (solo `workflow_dispatch`, `contents: read`, sin secretos).
2. Lanzarlo a mano 5 veces en momentos distintos (p. ej. 2 en horario laboral, 2 por la noche, 1 en fin de semana).
3. Leer el resumen del job: por URL, código HTTP, redirecciones, tiempo, tamaño y si `robots.txt` permite la ruta.
4. Decisión: ≥ 4/5 respuestas 200 estables ⇒ bloqueante con reintentos; si no ⇒ informativo + firma de excepción (F2.3c).

La sonda usa las mismas reglas que el verificador real: `User-Agent` identificable, respeto de `robots.txt`, redirecciones
validadas a mano, 1 petición por URL y pausa entre peticiones. No descarga más de 512 KB por respuesta.
