# apps/worker
Punto de entrada de los workers (BullMQ llega en el hito que lo necesite). Mismo código de dominio que `apps/api`: este paquete es solo un ejecutable delgado que importa de `@sales-smart/api`. **En M0 solo existe el arranque con configuración y logger.**
