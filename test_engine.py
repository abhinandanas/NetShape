import asyncio
from main import engine, post_traffic, post_config, post_reset, get_state, TrafficRequest, ConfigRequest

async def run_tests():
    print("Testing initial state...")
    st = engine.get_state()
    assert st['metrics']['bucket_capacity'] == 15
    assert st['metrics']['leak_rate'] == 5.0
    assert st['metrics']['shaper_enabled'] is True
    print("Initial state verified:", st['metrics'])

    # Test ingesting Zoom packets
    res = await post_traffic(TrafficRequest(source='zoom', count=3))
    print("Traffic post result:", res)
    assert res['ingested'] == 3
    st = engine.get_state()
    assert st['metrics']['buffered_count'] == 3
    print("Buffered count verified:", st['metrics']['buffered_count'])

    # Test leak step
    await engine.leak_step()
    st = engine.get_state()
    assert st['metrics']['buffered_count'] == 2
    assert st['metrics']['transmitted_count'] == 1
    print("After leak step: buffered=", st['metrics']['buffered_count'], "transmitted=", st['metrics']['transmitted_count'])

    # Test buffer overflow drop
    engine.reset()
    await post_config(ConfigRequest(bucket_capacity=5))
    res = await post_traffic(TrafficRequest(source='steam', count=10))
    st = engine.get_state()
    print("Overflow test: buffered=", st['metrics']['buffered_count'], "dropped=", st['metrics']['dropped_count'])
    assert st['metrics']['buffered_count'] == 5
    assert st['metrics']['dropped_count'] == 5

    # Test Bypass mode (Shaper OFF)
    engine.reset()
    await post_config(ConfigRequest(shaper_enabled=False))
    # In bypass, raw link capacity is 5.0 pkts/s. Inject 8 pkts at once
    res = await post_traffic(TrafficRequest(source='steam', count=8))
    st = engine.get_state()
    print("Bypass test: transmitted=", st['metrics']['transmitted_count'], "dropped=", st['metrics']['dropped_count'])
    assert st['metrics']['transmitted_count'] == 5
    assert st['metrics']['dropped_count'] == 3

    # Test reset
    await post_reset()
    st = engine.get_state()
    assert st['metrics']['transmitted_count'] == 0
    assert st['metrics']['dropped_count'] == 0
    print("Reset verified successfully!")

if __name__ == "__main__":
    asyncio.run(run_tests())
    print("ALL TESTS PASSED SUCCESSFULLY!")
