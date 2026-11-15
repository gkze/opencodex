---
title: Nivel Ultra Fast
description: Cómo declarar, enrutar y confirmar el nivel de servicio Ultra Fast, por encima del Fast canónico.
---

Ultra Fast es el nivel por encima de Fast: el servidor lo anuncia como una segunda entrada de `service_tiers`
(`{"id":"ultrafast"}`) con `additional_speed_tiers: ["fast","ultrafast"]`. OpenCodex lo trata como un
nivel canónico al que se puede ESTABLECER una ruta, no solo como un valor que reenvía cuando un cliente lo aporta.

## Declaraciones

Se necesitan dos declaraciones, y ninguna sustituye a la otra:

- **capacidad**: `supportsUltraFast`, o un `modelSupportsUltraFast: true` exacto por modelo cuando solo
  algunas filas llevan el nivel. La entrada `openai` incluida declara lo segundo para los dos modelos en
  los que su lista en vivo anuncia el nivel;
- **una grafía de cable**: `fastWire.canonicalToWire.ultrafast`, por ejemplo
  `{"kind":"service-tier","canonicalToWire":{"priority":"priority","ultrafast":"ultrafast"}}`.

Ambos son campos de la entrada de proveedor. Los campos de capacidad se definen aquí; la grafía de cable
y el resto del [contrato de campos del proveedor](/es/reference/configuration/providers/#provider-entries-ocxproviderconfig)
se definen allí.

| Campo | Tipo | Significado |
| --- | --- | --- |
| `supportsUltraFast?` | `boolean` | Capacidad Ultra Fast de tres estados, un nivel por encima del Fast canónico. `true` permite que `fastMode: "ultrafast"` establezca la grafía de cable `ultrafast` de este proveedor y que sus modelos publiquen el nivel en el catálogo; `false` deniega el nivel por completo. La capacidad sola no basta: la ruta también necesita una grafía `fastWire.canonicalToWire.ultrafast`, porque un nivel sin valor de cable no tiene nada que enviar. Si se omite, la ruta queda sin clasificar, así que un `ultrafast` aportado por el cliente solo pasa con el permiso de reenvío del cable final. Consulta [Nivel Ultra Fast](/es/reference/configuration/ultra-fast/) para la regla de descartar en lugar de degradar y las filas del catálogo. |
| `modelSupportsUltraFast?` | `Record<string, boolean>` | Anulaciones exactas por modelo ascendente para Ultra Fast, resueltas igual que `modelSupportsServiceTier`: un `true` exacto habilita el nivel para ese modelo y un `false` exacto restringe un `true` de todo el proveedor. Prefiere esto a `supportsUltraFast` cuando solo algunas filas anuncian el nivel: un `true` de todo el proveedor ofrece Ultra Fast en todos los modelos, incluidas las filas que el servidor solo sirve en Fast. |

## Establecer el nivel

Establece el nivel con `fastMode: "ultrafast"`, o deja que el cliente lo pida directamente mediante
`service_tier`. Una ruta que declara la capacidad pero no publica ninguna grafía no se puede establecer,
como tampoco una ruta sin clasificar: es la misma regla que mantiene la inyección del Fast canónico fuera
de las rutas sin clasificar. El selector **Fast Mode** de Claude Code en el panel ofrece Ultra Fast como
opción propia junto a ON, OFF y Auto, así que un `"ultrafast"` guardado se muestra y se guarda como Ultra Fast.

`fastMode: "ultrafast"` es una demanda de nivel y no un interruptor del carril Fast, así que la reescritura
[Cursor Fast](/es/reference/configuration/providers/#cursor-fast-cursor-variant) no la sigue: Cursor
conserva sus ids genéricos y, como el cable de la variante cursor no publica ninguna grafía `ultrafast`,
la demanda se descarta y se registra como una degradación.

## Demandas que no se pueden cumplir

Una demanda que no se puede atender se descarta en lugar de degradarse en silencio a Fast: el intento
registra `fastOutcome: "downgraded"` con `wire-unavailable`, de modo que el registro indica que se pidió el
nivel y no se entregó. Cuando el eco del destino es autoritativo, un eco `ultrafast` confirma el nivel y
cualquier otro eco registra `response-declined`.

## Filas del catálogo

Las filas del catálogo siguen las mismas pruebas. Un modelo enrutado cuyo par proveedor/modelo declara
ambas mitades publica la fila Ultra Fast después de sus niveles existentes (Fast, y Flex donde la ruta lo
reenvía), y el selector de Codex la ofrece entonces. No se sintetiza nada: un par que no declara nada
conserva su fila solo Fast, y las filas nativas siguen tomando sus niveles de los datos del servidor —la
instantánea fijada o la lista en vivo— y no de esta declaración. La opción aparte `ultraFastTier` sigue
rigiendo solo si una fila Ultra Fast añadida a mano por un operador sobrevive a la regeneración del catálogo.
