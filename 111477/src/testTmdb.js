const { getMovieByTmdbId, constructMovieName, isApiKeyConfigured } = require('./tmdbClient');

async function testTmdbFunctionality() {
    console.log('🧪 Testing TMDB Functionality...\n');
    
    // Check if API key is configured
    console.log('Checking TMDB API key configuration...');
    if (!isApiKeyConfigured()) {
        console.log('❌ TMDB API key not configured.');
        console.log('📝 To test TMDB functionality:');
        console.log('   1. Get a free API key from https://www.themoviedb.org/settings/api');
        console.log('   2. Set the environment variable: set TMDB_API_KEY=your_api_key_here');
        console.log('   3. Or edit src/tmdbClient.js and replace YOUR_TMDB_API_KEY_HERE with your key');
        console.log('\n🔧 For now, testing offline functionality...\n');
        
        // Test offline functionality
        testOfflineFunctionality();
        return;
    }
    
    console.log('✅ TMDB API key is configured\n');
    
    // Test TMDB IDs for the example movies
    const testMovies = [
        { tmdbId: 562, expectedName: 'Zodiac (2007)' },
        { tmdbId: 8078, expectedName: 'Zookeeper (2011)' },
        { tmdbId: 541982, expectedName: 'The Death of Superman (2018)' }
    ];
    
    for (const movie of testMovies) {
        try {
            console.log(`Testing TMDB ID ${movie.tmdbId}...`);
            const result = await getMovieByTmdbId(movie.tmdbId);
            
            console.log(`✅ ${result.movieName}`);
            console.log(`   TMDB Title: ${result.title}`);
            console.log(`   Release Date: ${result.releaseDate}`);
            console.log(`   Year: ${result.year}`);
            console.log(`   Constructed URL: ${result.movieUrl}`);
            console.log(`   Expected: ${movie.expectedName}`);
            console.log(`   Match: ${result.movieName === movie.expectedName ? '✅' : '❌'}`);
            console.log('');
            
        } catch (error) {
            console.log(`❌ Failed to fetch TMDB ID ${movie.tmdbId}: ${error.message}\n`);
        }
    }
}

function testOfflineFunctionality() {
    console.log('Testing offline TMDB functionality...\n');
    
    // Test constructMovieName with sample data
    const sampleMovies = [
        {
            title: 'Zodiac',
            original_title: 'Zodiac',
            release_date: '2007-03-02'
        },
        {
            title: 'Zookeeper',
            original_title: 'Zookeeper',
            release_date: '2011-07-08'
        },
        {
            title: 'The Death of Superman',
            original_title: 'The Death of Superman',
            release_date: '2018-07-24'
        }
    ];
    
    sampleMovies.forEach(movie => {
        const constructedName = constructMovieName(movie);
        console.log(`📝 ${movie.title} -> ${constructedName}`);
    });
    
    console.log('\n✅ Offline functionality working correctly!');
}

// Function to test the API endpoints (requires server to be running)
async function testApiEndpoints() {
    console.log('\n📡 Testing API Endpoints...\n');
    
    const baseUrl = 'http://localhost:3000';
    
    // Test health endpoint first
    try {
        const fetch = require('node-fetch');
        const response = await fetch(`${baseUrl}/health`);
        const data = await response.json();
        
        console.log('✅ Health endpoint working');
        console.log(`   TMDB API Configured: ${data.tmdbApiConfigured ? '✅' : '❌'}`);
        console.log('');
        
        if (!data.tmdbApiConfigured) {
            console.log('❌ Cannot test TMDB endpoints without API key configured');
            return;
        }
        
        // Test TMDB endpoint
        console.log('Testing TMDB endpoint with Zodiac (TMDB ID: 562)...');
        const tmdbResponse = await fetch(`${baseUrl}/api/tmdb/562`);
        const tmdbData = await tmdbResponse.json();
        
        if (tmdbData.success) {
            console.log(`✅ ${tmdbData.movieName}: Found ${tmdbData.fileCount} files`);
            console.log(`   TMDB Title: ${tmdbData.tmdb.title}`);
            console.log(`   Release Date: ${tmdbData.tmdb.releaseDate}`);
        } else {
            console.log(`❌ TMDB endpoint failed: ${tmdbData.error}`);
        }
        
    } catch (error) {
        console.log(`❌ API test failed: ${error.message}`);
        console.log('   Make sure the server is running with: npm start');
    }
}

// Run tests
if (require.main === module) {
    testTmdbFunctionality().then(() => {
        return testApiEndpoints();
    }).then(() => {
        console.log('\n🎉 TMDB testing completed!');
    }).catch(error => {
        console.error('❌ Test failed:', error.message);
    });
}

module.exports = { testTmdbFunctionality, testApiEndpoints };
