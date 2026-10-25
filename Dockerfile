FROM node:22-alpine
WORKDIR /app
COPY serve.cjs gravity-util.cjs gravity-upstream.cjs gravity-public.cjs gravity-share.cjs gravity-static.cjs \
     gravity-sign-ios.cjs gravity-api.cjs gravity-owner.cjs gravity-member.cjs gravity-feed.cjs gravity-encrypt.cjs \
     gravity-pb.cjs gravity-maf.cjs gravity-maf-keys.json gravity-imcore.cjs gravity-im-message.cjs gravity-im.cjs gravity-profile.cjs gravity-people.cjs gravity-relation.cjs gravity-translate.cjs gravity-tasks.cjs gravity-rewards.cjs ./
COPY static ./static
ENV GRAVITY_SERVE_HOST=0.0.0.0 GRAVITY_SERVE_PORT=8787 GRAVITY_TLS_PORT=8788
ENV GRAVITY_TLS_CERT=/tls/cert.pem GRAVITY_TLS_KEY=/tls/key.pem
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "serve.cjs"]
