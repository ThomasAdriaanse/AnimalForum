# Node 18.x is LTS
FROM node:18.18.0
ENV IS_DOCKER=true

# Transcrypt dependency
RUN apt-get update && apt-get install -y bsdmainutils

# Install transcrypt for EA Forum
RUN curl -sSLo /usr/local/bin/transcrypt https://raw.githubusercontent.com/elasticdog/transcrypt/2f905dce485114fec10fb747443027c0f9119caa/transcrypt && chmod +x /usr/local/bin/transcrypt

WORKDIR /usr/src/app

# Copy only files necessary for yarn install, to avoid spurious changes
# triggering re-install
COPY package.json package.json
COPY yarn.lock yarn.lock
COPY public/lesswrong-editor public/lesswrong-editor
COPY scripts/postinstall.sh scripts/postinstall.sh

# Install dependencies and clear the cache
RUN yarn install && yarn cache clean

# Copy the rest of the application
COPY . .

# Set execute permissions for all shell scripts and js files in the application directory
RUN find . -type f -iname "*.sh" -exec chmod +x {} \; && \
    find . -type f -iname "*.js" -exec chmod +x {} \;

EXPOSE 8080

CMD [ "yarn", "run", "production" ]
