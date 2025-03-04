const CombinedScraper = require('./combinedScraper.js');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Configure Puppeteer with stealth
puppeteer.use(StealthPlugin());

async function testScraper() {
  try {
    console.log('Creating scraper instance...');
    const scraper = new CombinedScraper({
      concurrency: 1,
      headless: false,
      delay: 1000,
      retries: 2
    });
    
    console.log('Testing Axios request...');
    const axiosResult = await scraper.scrapeWithAxios('https://carcruisefinder.com/');
    console.log('Axios test result:', {
      success: axiosResult.success,
      linksFound: axiosResult.eventLinks.length
    });
    
    console.log('\nTesting state scraping (first state only)...');
    let states;
    
    try {
      // Try to load existing states file
      console.log('Checking for existing states file...');
      await fs.access(scraper.statesFile);
      console.log('Loading existing states file...');
      states = JSON.parse(await fs.readFile(scraper.statesFile, 'utf8'));
      console.log(`Found ${states.length} states in file`);
    } catch (error) {
      console.log('No states file found, scraping first state...');
      // Just get the first state for testing
      const browser = await puppeteer.launch({
        headless: scraper.useHeadless,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders(scraper.headers);
        await page.setUserAgent(scraper.headers['User-Agent']);
        
        await page.goto(scraper.baseUrl, {
          waitUntil: 'load',
          timeout: 60000
        });
        
        await page.waitForSelector('#cat');
        
        // Get just the first state
        const firstState = await page.evaluate(() => {
          const stateSelect = document.getElementById('cat');
          const option = stateSelect.options[1]; // Skip the first empty option
          return {
            id: option.value,
            name: option.text
          };
        });
        
        console.log('First state:', firstState);
        
        // Click on state dropdown
        await page.click('#cat');
        
        // Select the state
        await page.select('#cat', firstState.id);
        
        // Use mouse click to potentially trigger region loading
        const regionDropdown = await page.$('#region-dropdown');
        if (regionDropdown) {
          await regionDropdown.click();
        }
        
        // Wait for region dropdown to populate
        await page.evaluate(() => {
          return new Promise((resolve) => {
            const checkRegionDropdown = () => {
              const regionSelect = document.getElementById('region-dropdown');
              if (regionSelect && regionSelect.options.length > 1) {
                resolve();
              } else {
                setTimeout(checkRegionDropdown, 100);
              }
            };
            checkRegionDropdown();
          });
        });
        
        // Extract the "All X Car Shows" region
        const regions = await page.evaluate(() => {
          const regionSelect = document.getElementById('region-dropdown');
          return Array.from(regionSelect.options)
            .filter(option => 
              option.text.toLowerCase().includes('all') && 
              option.text.toLowerCase().includes('car shows') &&
              option.value !== ''
            )
            .map(option => ({
              name: option.text,
              url: option.value
            }));
        });
        
        firstState.regions = regions;
        states = [firstState];
        
        console.log('First state with regions:', firstState);
      } finally {
        await browser.close();
      }
    }
    
    if (states && states.length > 0 && states[0].regions && states[0].regions.length > 0) {
      const testState = states[0];
      const regionUrl = testState.regions[0].url;
      
      console.log(`\nTesting event scraping for ${testState.name} using ${regionUrl}...`);
      
      // Just get the first page of events
      const pageUrl = regionUrl.startsWith('http') 
        ? regionUrl 
        : `${scraper.baseUrl}${regionUrl}`;
      
      console.log(`Scraping ${pageUrl}`);
      
      // Try axios first
      const response = await scraper.scrapeWithAxios(pageUrl);
      
      if (!response.success || response.eventLinks.length === 0) {
        console.log('Axios failed or found no events, trying Puppeteer...');
        const puppeteerResponse = await scraper.scrapeWithPuppeteer(pageUrl);
        
        if (!puppeteerResponse.success) {
          console.log('Puppeteer also failed');
        } else {
          console.log(`Puppeteer found ${puppeteerResponse.eventLinks.length} events`);
          if (puppeteerResponse.eventLinks.length > 0) {
            console.log('First 3 event links:');
            puppeteerResponse.eventLinks.slice(0, 3).forEach(link => console.log(`- ${link}`));
          }
        }
      } else {
        console.log(`Axios found ${response.eventLinks.length} events`);
        if (response.eventLinks.length > 0) {
          console.log('First 3 event links:');
          response.eventLinks.slice(0, 3).forEach(link => console.log(`- ${link}`));
        }
      }
    } else {
      console.log('No states or regions found for testing');
    }
    
    console.log('\nTest completed successfully');
  } catch (error) {
    console.error('Test failed with error:', error);
  }
}

testScraper()
  .then(() => console.log('Test script finished'))
  .catch(error => console.error('Unhandled error in test script:', error)); 