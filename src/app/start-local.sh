#!/bin/bash

# Local development startup script for Sunbird Portal
# This sets the necessary environment variables to point to local services

export sunbird_environment=local
export sunbird_instance=sunbird
export sunbird_default_channel=sunbird

# Point to local Content Service (NOT the portal itself!)
export sunbird_content_proxy_url=http://localhost:9000
export sunbird_content_player_url=http://localhost:9000/api/
export sunbird_learner_player_url=http://localhost:9000/api/

# Disable API whitelist for local development
export sunbird_enable_api_whitelist=false

echo "🚀 Starting Sunbird Portal with local configuration..."
echo "📍 Content Service: http://localhost:9000"
echo "📍 Portal: http://localhost:3000"
echo ""

npm run server
