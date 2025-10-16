const { parseMovieDirectory } = require('./parser');
const { fetchHtml } = require('./httpClient');

// Sample HTML from the user's example (Zodiac 2007)
const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>Index of /movies/Zodiac (2007)</title>
</head>
<body>
    <table>
        <tbody>
            <tr>
                <td>
                    <a href=../ class=parent-dir>../ (Parent Directory)</a>
                </td>
                <td data-sort=-1>-</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac - Director's Cut (2007) (1080p BDRip x265 10bit EAC3 5.1 - Nostradamus)[TAoE]-xpost.mkv">Zodiac - Director's Cut (2007) (1080p BDRip x265 10bit EAC3 5.1 - Nostradamus)[TAoE]-xpost.mkv</a>
                </td>
                <td data-sort=4831603033>4831603033</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac 2007 1080p BluRay DC x264 AAC 88.mp4">Zodiac 2007 1080p BluRay DC x264 AAC 88.mp4</a>
                </td>
                <td data-sort=2556658082>2556658082</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac 2007 1080p REMUX ENG And ESP LATINO Dolby TrueHD DDP5 1 MKV BEN THE MEN.mkv">Zodiac 2007 1080p REMUX ENG And ESP LATINO Dolby TrueHD DDP5 1 MKV BEN THE MEN.mkv</a>
                </td>
                <td data-sort=44305229275>44305229275</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac.(2007).DIRECTORS.CUT.1080p.BluRay.5.1-LAMA.mp4">Zodiac.(2007).DIRECTORS.CUT.1080p.BluRay.5.1-LAMA.mp4</a>
                </td>
                <td data-sort=3218582471>3218582471</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac.2007.Directors.Cut.1080p.BluRay.DD.5.1.X265-Ralphy.mkv">Zodiac.2007.Directors.Cut.1080p.BluRay.DD.5.1.X265-Ralphy.mkv</a>
                </td>
                <td data-sort=5041994434>5041994434</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac.2007.Directors.Cut.1080p.BluRay.REMUX.AVC.TrueHD.5.1-PrivateHD-Obfuscated.mkv">Zodiac.2007.Directors.Cut.1080p.BluRay.REMUX.AVC.TrueHD.5.1-PrivateHD-Obfuscated.mkv</a>
                </td>
                <td data-sort=43511022936>43511022936</td>
            </tr>
            <tr>
                <td>
                    <a href="https://a.111477.xyz/movies/Zodiac (2007)/Zodiac.2007.Directors.Cut.Bluray.1080p.TrueHD.5.1.AVC.REMUX-FraMeSToR.mkv">Zodiac.2007.Directors.Cut.Bluray.1080p.TrueHD.5.1.AVC.REMUX-FraMeSToR.mkv</a>
                </td>
                <td data-sort=43511019082>43511019082</td>
            </tr>
        </tbody>
    </table>
</body>
</html>
`;

async function testParser() {
    console.log('🧪 Testing Movie Parser...\n');
    
    // Test 1: Parse sample HTML
    console.log('Test 1: Parsing sample Zodiac (2007) HTML...');
    const result = parseMovieDirectory(sampleHtml, 'https://a.111477.xyz/movies/Zodiac%20(2007)/');
    
    console.log('✅ Results:');
    console.log(`   Movie Name: ${result.movieName}`);
    console.log(`   File Count: ${result.fileCount}`);
    console.log('   Files found:');
    
    result.files.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.name}`);
        console.log(`      URL: ${file.url}`);
        console.log(`      Size: ${file.sizeFormatted} (${file.size} bytes)`);
        console.log('');
    });
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Test 2: Test with live URLs (if accessible)
    const testUrls = [
        'https://a.111477.xyz/movies/The%20Death%20of%20Superman%20(2018)/',
        'https://a.111477.xyz/movies/Zookeeper%20(2011)/',
        'https://a.111477.xyz/movies/Zodiac%20(2007)/'
    ];
    
    for (const url of testUrls) {
        try {
            console.log(`Test: Fetching ${url}...`);
            const html = await fetchHtml(url);
            const result = parseMovieDirectory(html, url);
            
            console.log(`✅ ${result.movieName}: Found ${result.fileCount} files`);
            
            if (result.files.length > 0) {
                console.log('   Top files:');
                result.files.slice(0, 3).forEach((file, index) => {
                    console.log(`   ${index + 1}. ${file.name} (${file.sizeFormatted})`);
                });
            }
            console.log('');
            
        } catch (error) {
            console.log(`❌ Failed to fetch ${url}: ${error.message}\n`);
        }
    }
}

// Function to test API endpoints (mock)
function testApiEndpoints() {
    console.log('📡 API Endpoints Available:\n');
    
    const endpoints = [
        {
            method: 'GET',
            path: '/api/movies/:movieName',
            example: '/api/movies/Zodiac%20(2007)',
            description: 'Get movie files by movie name'
        },
        {
            method: 'POST',
            path: '/api/parse',
            example: '{ "url": "https://a.111477.xyz/movies/Zodiac%20(2007)/" }',
            description: 'Parse custom movie URL'
        },
        {
            method: 'POST',
            path: '/api/parse-batch',
            example: '{ "urls": ["url1", "url2"] }',
            description: 'Parse multiple URLs at once'
        },
        {
            method: 'GET',
            path: '/health',
            example: '/health',
            description: 'Health check endpoint'
        }
    ];
    
    endpoints.forEach(endpoint => {
        console.log(`${endpoint.method} ${endpoint.path}`);
        console.log(`   Description: ${endpoint.description}`);
        console.log(`   Example: ${endpoint.example}`);
        console.log('');
    });
}

// Run tests
if (require.main === module) {
    testParser().then(() => {
        testApiEndpoints();
        console.log('🎉 Testing completed!');
    }).catch(error => {
        console.error('❌ Test failed:', error.message);
    });
}

module.exports = { testParser, testApiEndpoints };
