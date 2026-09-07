FROM nginx:1.27-alpine

# nginx-module-njs: ships ngx_http_js_module.so, requires njs >= 0.8.1 for js_periodic.
# gettext: provides envsubst, used at start to bake REDIRECTS_INTERVAL_MS into nginx.conf
# (js_periodic's interval is read once at config load, not from process.env at runtime).
RUN apk add --no-cache nginx-module-njs gettext

COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
COPY redirects.js /etc/nginx/njs/redirects.js

ENV REDIRECTS_INTERVAL_MS=60000
ENV ORIGIN_UPSTREAM=origin:3000

EXPOSE 8080

CMD ["sh", "-c", "envsubst '$REDIRECTS_INTERVAL_MS $ORIGIN_UPSTREAM' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf && exec nginx -g 'daemon off;'"]
