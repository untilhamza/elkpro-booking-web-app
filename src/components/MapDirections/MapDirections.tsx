import React from 'react'
import Button from "react-bootstrap/Button";


const MapDirections = () => {

  const handleViewKakaoMapClick = () => {
    //window.open(`https://map.kakao.com/link/to/Elkpro services,37.535323741447456, 126.99206905398854`);
    window.open(`https://kko.to/tZt6z9cKSc`);
  };
  const handleViewGoogleMapClick = () => {
    //window.open(`https://www.google.com/maps/search/?api=1&query=37.535323741447456, 126.99206905398854`);
    window.open(`https://www.google.com/maps/search/?api=1&query=37.543531, 126.957720`);
  };
  
  return (
    <div className="mb-2 row p-3 gap-2">
      <Button variant="primary col" className="d-block w-100" onClick={handleViewKakaoMapClick}>
        Kakao Map Directions
      </Button>
      <Button variant="primary col" className="d-block w-100" onClick={handleViewGoogleMapClick}>
        Google Map Directions
      </Button>
    </div>
  );
}

export default MapDirections
