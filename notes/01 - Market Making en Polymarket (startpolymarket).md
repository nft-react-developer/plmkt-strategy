---
tags: [market-making, rewards, estrategia, polymarket]
source: https://startpolymarket.com/es/estrategias/creacion-mercado/
fecha: 2026-04-14
tipo: resumen-articulo
---

# Market Making en Polymarket — Gana el Spread Sin Apuestas Direccionales

## Concepto central

Publicar simultáneamente bid y ask en el mismo contrato, capturando el spread como ganancia **sin exposición direccional** al resultado.

---

## Estructura de comisiones

- Makers **no pagan comisiones**
- Reciben **rebate del 25%** sobre fees de takers (20% en categoría cripto)
- Ventaja estructural frente a otros exchanges

---

## Mecánica práctica

### Selección de mercados
- Evaluar: spread disponible, volumen, tiempo a resolución
- Evitar mercados **cerca de resolución** → riesgo asimétrico alto

### Cotizaciones
| Spread | Ejecuciones | Margen |
|---|---|---|
| Amplio | Menos | Mayor |
| Ajustado | Más | Menor protección |

- Para principiantes: **enfoque simétrico** (igual distancia bid/ask del midprice)

### Gestión de inventario
- Ajustar cotizaciones para mantener balance entre lados
- Limitar posiciones sesgadas
- Monitoreo activo obligatorio

---

## Riesgo principal: Selección Adversa

> "Este riesgo es tan severo en Polymarket porque los contratos resuelven a $1.00 o $0.00 — las noticias causan saltos discontinuos y catastróficos."

Traders informados operan contra cotizaciones obsoletas del maker.

### Mitigación
- Evitar mercados cerca de eventos clave
- Ampliar spreads en momentos de alta incertidumbre
- Limitar tamaño máximo por posición
- Monitorear activamente fuentes de noticias

---

## Capital requerido

| Nivel | Capital estimado |
|---|---|
| Experimental (1 mercado) | Varios cientos de USD |
| Operación seria (multi-mercado) | Varios miles de USD |

Capital debe cubrir **ambos lados del book** + fluctuaciones de inventario.

---

## Tensión rewards vs market making

> Punto clave para este proyecto:

- Rewards requieren cotizaciones **ajustadas** (cerca del midprice)
- Market making puro requiere spreads **amplios** para protegerse
- **Recomendación del artículo:** priorizar spreads seguros sobre maximizar rewards

→ Ver [[00 - Proyecto Overview]] para cómo la estrategia actual maneja este trade-off.

---

## Consejos clave

1. Empezar con **un solo mercado**
2. Usar API para automatización y escalar
3. Trackear P&L rigurosamente — *ingresos llegan despacio, pérdidas rápido*
4. Considerar el riesgo de ser "adelantado" por otros makers
5. Tratar selección adversa como **costo operativo**, no excepción

---

## Conclusión

> "El market making en Polymarket **no es una estrategia de ingresos pasivos**" — requiere monitoreo activo y entender bien los riesgos de cola.
