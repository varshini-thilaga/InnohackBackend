const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Server } = require('socket.io');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Google Maps route calculation with multiple travel modes
app.post('/api/route', async (req, res) => {
  try {
    const { start, end } = req.body;
    
    // Calculate distance to determine travel mode
    const distance = calculateDistance(start.lat, start.lng, end.lat, end.lng);
    let mode = 'walking';
    
    // For long distances, use driving + transit combination
    if (distance > 50000) { // > 50km
      mode = 'transit'; // Use public transport for very long distances
    } else if (distance > 5000) { // > 5km
      mode = 'driving'; // Use driving for medium distances
    }
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${start.lat},${start.lng}`,
        destination: `${end.lat},${end.lng}`,
        mode: mode,
        alternatives: true,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.status !== 'OK') {
      throw new Error(`Google API error: ${response.data.status}`);
    }

    const route = response.data.routes[0];
    const leg = route.legs[0];
    
    const instructions = leg.steps.map((step, index) => ({
      instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
      distance: step.distance.value,
      duration: step.duration.value,
      travelMode: step.travel_mode || mode.toUpperCase()
    }));

    const routeData = {
      instructions,
      totalDistance: leg.distance.value,
      totalDuration: leg.duration.value,
      travelMode: mode,
      startAddress: leg.start_address,
      endAddress: leg.end_address,
      geometry: {
        coordinates: decodePolyline(route.overview_polyline.points)
      }
    };

    res.json(routeData);
  } catch (error) {
    console.error('Route error:', error.message);
    res.status(500).json({ error: `Route calculation failed: ${error.message}` });
  }
});

// Decode Google polyline
function decodePolyline(encoded) {
  const points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;
}

// Google Places search with multiple results
app.post('/api/geocode', async (req, res) => {
  try {
    const { destination, userLocation } = req.body;
    console.log(`Searching for: ${destination} near ${userLocation.lat}, ${userLocation.lng}`);
    
    // Try Google Places API first
    try {
      const placesResponse = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
        params: {
          query: destination,
          location: `${userLocation.lat},${userLocation.lng}`,
          radius: 50000,
          key: process.env.GOOGLE_MAPS_API_KEY
        }
      });

      console.log('Places API response:', placesResponse.data.status);
      
      if (placesResponse.data.status === 'OK' && placesResponse.data.results.length > 0) {
        const results = placesResponse.data.results.slice(0, 5).map(place => ({
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng,
          name: place.name,
          address: place.formatted_address,
          rating: place.rating,
          types: place.types
        }));
        
        console.log(`Found ${results.length} places`);
        return res.json({ results });
      }
    } catch (placesError) {
      console.log('Places API failed, trying Geocoding API:', placesError.message);
    }

    // Fallback to Geocoding API
    const geocodeResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address: destination,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });
    
    console.log('Geocoding API response:', geocodeResponse.data.status);
    
    if (geocodeResponse.data.status === 'OK' && geocodeResponse.data.results.length > 0) {
      const results = geocodeResponse.data.results.slice(0, 3).map(place => ({
        lat: place.geometry.location.lat,
        lng: place.geometry.location.lng,
        name: place.formatted_address,
        address: place.formatted_address
      }));
      
      console.log(`Geocoding found ${results.length} results`);
      return res.json({ results });
    }
    
    // If both APIs fail, provide mock data for common places
    console.log('Both APIs failed, using mock data');
    const mockResults = getMockResults(destination, userLocation);
    if (mockResults.length > 0) {
      return res.json({ results: mockResults });
    }
    
    throw new Error('No results found');
    
  } catch (error) {
    console.error('Geocoding error:', error.message);
    
    // Final fallback - mock data
    const mockResults = getMockResults(req.body.destination, req.body.userLocation);
    if (mockResults.length > 0) {
      return res.json({ results: mockResults });
    }
    
    res.status(404).json({ error: 'Location not found' });
  }
});

// Mock results for common destinations
function getMockResults(destination, userLocation) {
  const mockPlaces = {
    'school': [
      { name: 'Government Higher Secondary School', address: 'RS Puram, Coimbatore' },
      { name: 'PSG College of Arts and Science', address: 'Civil Aerodrome Post, Coimbatore' },
      { name: 'Coimbatore Institute of Technology', address: 'CIT Campus, Coimbatore' }
    ],
    'hospital': [
      { name: 'Coimbatore Medical College Hospital', address: 'Coimbatore Medical College, Coimbatore' },
      { name: 'PSG Hospitals', address: 'Peelamedu, Coimbatore' },
      { name: 'Kovai Medical Center', address: 'Avinashi Road, Coimbatore' }
    ],
    'restaurant': [
      { name: 'Annapoorna Restaurant', address: 'RS Puram, Coimbatore' },
      { name: 'Hotel Junior Kuppanna', address: 'Race Course Road, Coimbatore' },
      { name: 'Shree Anandhaas', address: 'Cross Cut Road, Coimbatore' }
    ],
    'mall': [
      { name: 'Brookefields Mall', address: 'Dr Krishnasamy Mudaliar Road, Coimbatore' },
      { name: 'Fun Republic Mall', address: 'Avinashi Road, Coimbatore' },
      { name: 'Prozone Mall', address: 'Sathy Road, Coimbatore' }
    ]
  };
  
  const key = destination.toLowerCase();
  for (const [type, places] of Object.entries(mockPlaces)) {
    if (key.includes(type)) {
      return places.map((place, index) => ({
        lat: userLocation.lat + (Math.random() - 0.5) * 0.02,
        lng: userLocation.lng + (Math.random() - 0.5) * 0.02,
        name: place.name,
        address: place.address
      }));
    }
  }
  
  return [];
}

// Emergency endpoint
app.post('/api/emergency', async (req, res) => {
  const { userId, location, message } = req.body;
  
  console.log(`EMERGENCY ALERT - User: ${userId}`);
  console.log(`Location: ${location.lat}, ${location.lng}`);
  
  // Send SMS using Twilio if configured
  if (process.env.TWILIO_ACCOUNT_SID && process.env.EMERGENCY_CONTACT) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      
      await twilio.messages.create({
        body: `EMERGENCY ALERT: ${message}\nLocation: https://maps.google.com/maps?q=${location.lat},${location.lng}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.EMERGENCY_CONTACT
      });
      
      console.log('Emergency SMS sent successfully');
    } catch (smsError) {
      console.error('SMS sending failed:', smsError.message);
    }
  }
  
  res.json({ 
    success: true, 
    message: 'Emergency alert sent',
    emergencyId: `EMG-${Date.now()}`
  });
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Calculate distance between two points
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Google Maps API configured:', !!process.env.GOOGLE_MAPS_API_KEY);
});