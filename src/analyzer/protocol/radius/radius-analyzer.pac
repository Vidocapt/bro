# Generated by binpac_quickstart

refine flow RADIUS_Flow += {
	function proc_radius_message(msg: RADIUS_PDU): bool
		%{
		connection()->bro_analyzer()->ProtocolConfirmation();

		if ( !radius_message ) return false;

		RecordVal* result = new RecordVal(BifType::Record::RADIUS::Message);
		result->Assign(0, new Val(${msg.code}, TYPE_COUNT));
		result->Assign(1, new Val(${msg.trans_id}, TYPE_COUNT));
		result->Assign(2, bytestring_to_val(${msg.authenticator}));
		
		TableVal* Attributes = new TableVal(BifType::Table::RADIUS::Attributes);

		for ( uint i = 0; i < ${msg.attributes}->size(); ++i ) {
			// Do we already have a vector of attributes for this type?
			VectorVal* current = (VectorVal*) Attributes->Lookup(new Val(${msg.attributes[i].code}, TYPE_COUNT));
			if ( current )
				current->Assign((uint) current->Size(), bytestring_to_val(${msg.attributes[i].value}));
			else {
				VectorVal* AttributeList = new VectorVal(BifType::Vector::RADIUS::AttributeList);
				AttributeList->Assign((uint) 0, bytestring_to_val(${msg.attributes[i].value}));
				Attributes->Assign(new Val(${msg.attributes[i].code}, TYPE_COUNT), AttributeList);
			}
			
		}
		if ( ${msg.attributes}->size() )
			result->Assign(3, Attributes);
		BifEvent::generate_radius_message(connection()->bro_analyzer(), connection()->bro_analyzer()->Conn(), result);
		return true;
		%}

	function proc_radius_attribute(attr: RADIUS_Attribute): bool
		%{
		if ( !radius_attribute ) return false;

		BifEvent::generate_radius_attribute(connection()->bro_analyzer(), connection()->bro_analyzer()->Conn(), ${attr.code}, bytestring_to_val(${attr.value}));
		return true;
		%}
};

refine typeattr RADIUS_PDU += &let {
	proc: bool = $context.flow.proc_radius_message(this);
};

refine typeattr RADIUS_Attribute += &let {
	proc: bool = $context.flow.proc_radius_attribute(this);
};