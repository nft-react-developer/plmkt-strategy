# ADR 001 – Librerías y versiones fijas para backend y Telegram

**Status:** Accepted  
**Date:** 31-Mar-2026

## Contexto

- Proyecto Node.js con base de datos MySQL y bot de Telegram.  
- Necesidad de estabilidad, reproducibilidad y control de versiones en desarrollo y producción.

## Decisión

Se fijan las siguientes librerías y versiones:

**Base de datos**  
- `drizzle-orm@0.45.2`  
- `mysql2@3.20.0`

**Telegram (devDependencies)**  
- `node-telegram-bot-api@0.67.0`  
- `@types/node-telegram-bot-api@0.64.14`

## Motivación

- Garantizar compatibilidad y reproducibilidad de entornos.  
- ORM tipado y driver robusto para MySQL.  
- Librería de Telegram estable y con tipado TypeScript.  
- Evitar breaking changes inesperados en producción.

## Consecuencias

- Actualizaciones de librerías deben ser manuales y revisadas.  
- Todo el equipo debe usar las versiones fijadas.  
- CI/CD y tests ejecutarán siempre con estas versiones.