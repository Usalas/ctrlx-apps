#!/usr/bin/env bash
set -e
snapcraft clean --destructive-mode
snapcraft pack --destructive-mode --build-for=amd64
