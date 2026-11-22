# Despliegue regional de Xuper Web

La dirección pública sigue siendo la del servicio en Render. Cada petición a la web, el catálogo o el vídeo pasa por el filtro de país. Hay dos formas de proporcionar la conexión de salida.

## Opción con VPN dentro de Render

Esta opción usa solo la instancia de Render y un servicio WireGuard con una salida regional admitida por el proveedor. El operador de la VPN debe proporcionar una configuración WireGuard exportable, permitir tráfico desde servidores y admitir el volumen de vídeo previsto. El país de salida y los países de los visitantes se configuran por separado.

1. En Render abre **Environment → Secret Files → Add Secret File**. Nómbralo `wireproxy.conf`. Copia las secciones `[Interface]` y `[Peer]` del perfil WireGuard de tu servicio VPN, con la dirección del túnel, DNS, claves y endpoint que te haya asignado. Mantén las claves dentro de Render.
2. Añade al final del mismo archivo estas dos líneas:

   ```ini
   [Socks5]
   BindAddress = 127.0.0.1:1080
   ```

3. Configura `XUPER_EGRESS=wireguard`, `XUPER_EXIT_COUNTRY=PE`, `XUPER_COUNTRIES=PE` y `XUPER_MAX_SESSIONS=2`. Cambia el país de salida solo para un endpoint de ese país aceptado por el proveedor. Deja `XUPER_ROLE` sin definir. El modo VPN genera su propia clave temporal de cookies y prescinde del servidor regional separado.
4. Guarda y despliega. El cliente wireproxy usa el archivo en `/etc/secrets/wireproxy.conf`. Los procesos de catálogo y FFmpeg envían sus conexiones TCP externas por el proxy local. Cada reproductor comprueba el país de salida antes de atender la primera petición. La conexión UDP al endpoint VPN y el reconocimiento del país por el proveedor se deben verificar en el despliegue real.
5. Desde Perú, comprueba un catálogo actualizado y una reproducción real. Si aparece 503, revisa **Logs** de Render para distinguir un fallo de arranque del túnel de un país de salida incorrecto. Un bloqueo del proveedor tras esta comprobación significa que debes confirmar con él si admite esa IP.

## Opción con un servidor regional separado

## 1. Preparar el servidor regional

Usa una máquina Linux con Docker en un alojamiento autorizado por el proveedor. Comprueba el catálogo y una reproducción desde esa red antes de anunciar el servicio. Necesitas un dominio con HTTPS para conectar Render a esa máquina.

En un clon privado del repositorio, genera un secreto con `openssl rand -hex 32`. Guárdalo en el gestor de secretos del alojamiento y en las variables de Render. Para usar Docker directamente, guarda estas variables en un archivo privado **fuera del repositorio**, con permisos de lectura solo para el administrador.

```dotenv
XUPER_ROLE=regional
XUPER_PUBLIC_ORIGIN=https://xuper-web.onrender.com
XUPER_REGIONAL_SECRET=REEMPLAZAR_CON_EL_SECRETO_GENERADO
XUPER_MAX_SESSIONS=2
PORT=8080
```

Desde la raíz del repositorio ejecuta:

```sh
docker build -t xuper-regional .
docker run -d --name xuper-regional --restart unless-stopped --env-file /ruta/privada/regional.env -p 127.0.0.1:8080:8080 xuper-regional
```

Configura el proxy HTTPS del alojamiento para enviar las peticiones al puerto local 8080 y permitir streaming sin búfer. Por ejemplo, si usas Caddy en el host, esta configuración emite el certificado cuando el dominio resuelve a la máquina y los puertos 80 y 443 son accesibles:

```caddy
regional.tudominio.com {
    reverse_proxy 127.0.0.1:8080
}
```

Abre `https://regional.tudominio.com/healthz` para comprobar el proceso. El resto de las rutas regionales requiere el secreto de Render. Dimensiona el límite de sesiones según CPU, RAM y transferencia. La conversión de vídeo puede consumir un núcleo o más por espectador según el formato.

## 2. Configurar Render

En **Environment** del servicio público guarda estas variables y despliega `main`:

| Variable | Valor |
| --- | --- |
| `XUPER_REGIONAL_URL` | Origen HTTPS del servidor regional, por ejemplo `https://regional.tudominio.com` |
| `XUPER_REGIONAL_SECRET` | Mismo secreto generado en el paso anterior |
| `XUPER_COUNTRIES` | `PE` inicialmente. Añade únicamente países confirmados, separados por coma |

Render proporciona `RENDER` y `RENDER_EXTERNAL_URL`. Deja `XUPER_ROLE` sin definir en Render. Mantén `/healthz` como ruta de salud. Esta ruta prueba que el proceso está disponible. La prueba del catálogo se hace desde la interfaz.

## 3. Verificar el despliegue

1. Abre la web desde una conexión permitida. Comprueba que actualiza el catálogo y reproduce un título autorizado con audio.
2. Desde un segundo navegador con cookies independientes, reproduce otro título. Pausa y adelanta en el primero y verifica que el segundo continúa.
3. Desde una conexión fuera de los países habilitados, verifica que la portada, la API y un enlace de vídeo devuelven 403. El filtro usa el país que indica el borde público de Render en `CF-IPCountry`. Si el dato falta o es desconocido, el acceso se cierra. Este modo está destinado a la entrada pública de Render, que debe proporcionar ese encabezado de confianza.
4. Un 503 por configuración indica que falta el secreto o la URL regional. Un 502 indica que Render no puede comunicarse con el origen. Un 403 del servidor regional indica que debes comprobar el secreto. Si el proveedor devuelve un bloqueo regional, comprueba la IP de salida real del alojamiento.

La sesión se identifica por una cookie segura del navegador. Cada sesión inicia su propio proceso regional para el catálogo y el reproductor. Las sesiones sin peticiones activas se liberan después de unos diez minutos de inactividad. Si se alcanza el límite, los nuevos espectadores reciben 503 y las sesiones existentes continúan. El vídeo consume transferencia tanto del origen como de Render. El modo local de Windows se inicia como antes.
