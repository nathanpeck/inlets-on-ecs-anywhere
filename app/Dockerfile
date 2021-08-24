# Initial package install
FROM --platform=linux/arm64 node:14 AS build
WORKDIR /srv
ADD package.json .
RUN npm install

# Actual runtime image
FROM --platform=linux/arm64 node:14-slim
COPY --from=build /srv .
ARG TARGETPLATFORM
RUN echo "Building for $TARGETPLATFORM"
ADD . .
EXPOSE 3000
EXPOSE 80
COPY index.html /usr/share/nginx/html